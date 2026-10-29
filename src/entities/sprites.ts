import { isSolidBlocking, Mat, MatId } from '../core/materials';
import { HEIGHT, WIDTH, WorldGrid } from '../core/world';

export type SpriteKind = 'aqua_puff' | 'root_roller' | 'spark_bit';
export type SpriteState = 'wander' | 'seek' | 'deliver';

export interface SpriteEntity {
  id: number;
  kind: SpriteKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  state: SpriteState;
  carrying: MatId;     // 運搬中のマテリアル（Air なら未所持）
  energy: number;      // ピカリんの帯電量または行動スタミナ
  targetX: number;
  targetY: number;
  animTick: number;
  cooldown: number;
}

export const MAX_SPRITES = 80;

/**
 * 自律型精霊「スプライト (Sprites)」管理＆エコ・オートメーションFSM (Phase 3)
 * - モフみず (Aqua-Puff): 水辺＋発光キノコでスポーン。水を吸い、火災消火・乾燥土の灌漑・コア導水を行う
 * - コロねっこ (Root-Roller): 森林環境でスポーン。果実・蜜・黒曜石・星のかけらを拾ってコアへ運搬する
 * - ピカリん (Spark-Bit): 銅線・発電シダ・羽根車周辺でスポーン。電気を運んで機械やコアへ放電する
 */
export class SpriteManager {
  readonly sprites: SpriteEntity[] = [];
  private nextId = 1;

  // ライティングシステムへ渡す動的光源配列（再利用してGCを削減）
  private readonly lightPoints: { x: number; y: number; r: number; g: number; b: number }[] = [];

  clear(): void {
    this.sprites.length = 0;
  }

  /** 手動またはテスト用にスプライトをスポーンさせる */
  spawn(kind: SpriteKind, x: number, y: number): SpriteEntity | null {
    if (this.sprites.length >= MAX_SPRITES) return null;
    const sp: SpriteEntity = {
      id: this.nextId++,
      kind,
      x,
      y,
      vx: 0,
      vy: 0,
      facing: Math.random() < 0.5 ? 1 : -1,
      state: 'wander',
      carrying: Mat.Air,
      energy: 0,
      targetX: x,
      targetY: y,
      animTick: (Math.random() * 100) | 0,
      cooldown: 0,
    };
    this.sprites.push(sp);
    return sp;
  }

  /** 種類ごとの個体数を集計 */
  countByKind(): Record<SpriteKind, number> {
    const counts: Record<SpriteKind, number> = {
      aqua_puff: 0,
      root_roller: 0,
      spark_bit: 0,
    };
    for (let i = 0; i < this.sprites.length; i++) {
      counts[this.sprites[i].kind]++;
    }
    return counts;
  }

  /**
   * 1フレーム分の自然スポーン判定と全スプライトのFSM行動更新
   */
  update(world: WorldGrid): void {
    // 45フレームに1回、環境条件を満たしていれば自然スポーンを試みる
    if (world.tick % 45 === 0 && this.sprites.length < MAX_SPRITES) {
      this.tryNaturalSpawn(world);
    }

    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const sp = this.sprites[i];
      sp.animTick++;
      if (sp.cooldown > 0) sp.cooldown--;

      // 溶岩などの極端な高温セルに巻き込まれた場合は退避ジャンプ（死なせずにコージーに逃がす）
      const gx = Math.max(0, Math.min(WIDTH - 1, Math.round(sp.x)));
      const gy = Math.max(0, Math.min(HEIGHT - 1, Math.round(sp.y)));
      if (world.temp[world.idx(gx, gy)] >= 260) {
        sp.vy = -1.6;
        sp.vx = -sp.facing * 1.2;
      }

      if (sp.kind === 'aqua_puff') {
        this.updateAquaPuff(world, sp);
      } else if (sp.kind === 'root_roller') {
        this.updateRootRoller(world, sp);
      } else {
        this.updateSparkBit(world, sp);
      }
    }
  }

  /**
   * 箱庭の生態系条件に応じた自然スポーンチェック
   */
  private tryNaturalSpawn(world: WorldGrid): void {
    const counts = this.countByKind();

    for (let attempt = 0; attempt < 18; attempt++) {
      const rx = 6 + world.rng.nextInt(WIDTH - 12);
      const ry = 10 + world.rng.nextInt(HEIGHT - 16);
      if (world.getMat(rx, ry) !== Mat.Air) continue;

      const below = world.getMat(rx, ry + 1);

      // 1. モフみず: 発光キノコがあり、近くに水があるとき（上限12体）
      if (counts.aqua_puff < 12 && below === Mat.Mushroom) {
        if (this.findNearbyMat(world, rx, ry, 14, (m) => m === Mat.Water)) {
          this.spawn('aqua_puff', rx, ry - 1);
          return;
        }
      }

      // 2. コロねっこ: 植物の葉・花・茎が周囲に育っているとき（上限14体）
      if (counts.root_roller < 14 && (below === Mat.WetSoil || below === Mat.Soil || below === Mat.Wood)) {
        let floraScore = 0;
        for (let dy = -5; dy <= 2; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            const m = world.getMat(rx + dx, ry + dy);
            if (m === Mat.PlantStem || m === Mat.Leaf || m === Mat.Flower) floraScore++;
          }
        }
        if (floraScore >= 6) {
          this.spawn('root_roller', rx, ry);
          return;
        }
      }

      // 3. ピカリん: 銅線・発電シダ・羽根車の近く（上限12体）
      if (
        counts.spark_bit < 12 &&
        (below === Mat.Copper || below === Mat.VoltFern || below === Mat.RotorHub)
      ) {
        this.spawn('spark_bit', rx, ry - 1);
        return;
      }
    }
  }

  /**
   * モフみず (Aqua-Puff): 水を吸って火災消火・乾燥土の灌漑・コアへの水納品を行う
   */
  private updateAquaPuff(world: WorldGrid, sp: SpriteEntity): void {
    const gx = Math.round(sp.x);
    const gy = Math.round(sp.y);

    if (sp.carrying === Mat.Air) {
      // 足元または隣に水があれば吸い込む
      const waterPos = this.findNearbyMat(world, gx, gy, 2, (m) => m === Mat.Water);
      if (waterPos && sp.cooldown === 0) {
        world.setCell(waterPos.x, waterPos.y, Mat.Air);
        sp.carrying = Mat.Water;
        sp.state = 'deliver';
        sp.cooldown = 15;
      } else if (sp.animTick % 20 === 0) {
        const distantWater = this.findNearbyMat(world, gx, gy, 28, (m) => m === Mat.Water);
        if (distantWater) {
          sp.state = 'seek';
          sp.targetX = distantWater.x;
          sp.targetY = distantWater.y;
        } else {
          sp.state = 'wander';
        }
      }
    } else {
      // 水を保持中：優先順位 1.火災(Fire)消火 → 2.乾いた土(Soil)灌漑 → 3.コア(Core)納品
      const firePos = this.findNearbyMat(world, gx, gy, 30, (m) => m === Mat.Fire);
      if (firePos) {
        sp.targetX = firePos.x;
        sp.targetY = firePos.y;
        if (Math.abs(gx - firePos.x) <= 3 && Math.abs(gy - firePos.y) <= 4) {
          world.setCell(firePos.x, firePos.y, Mat.Steam, 90, 105);
          sp.carrying = Mat.Air;
          sp.state = 'wander';
          sp.cooldown = 20;
        }
      } else {
        const drySoil = this.findNearbyMat(world, gx, gy, 22, (m) => m === Mat.Soil);
        if (drySoil) {
          sp.targetX = drySoil.x;
          sp.targetY = drySoil.y;
          if (Math.abs(gx - drySoil.x) <= 2 && Math.abs(gy - drySoil.y) <= 3) {
            world.setCell(drySoil.x, drySoil.y, Mat.WetSoil, 180, 20);
            sp.carrying = Mat.Air;
            sp.state = 'wander';
            sp.cooldown = 20;
          }
        } else if (world.hasCore) {
          sp.targetX = world.coreX;
          sp.targetY = world.coreY;
          if (Math.abs(gx - world.coreX) <= 3 && Math.abs(gy - world.coreY) <= 3) {
            world.onCoreDeliver?.('water', 2);
            sp.carrying = Mat.Air;
            sp.state = 'wander';
            sp.cooldown = 25;
          }
        }
      }
    }

    this.moveGroundWalker(world, sp, 0.52);
  }

  /**
   * コロねっこ (Root-Roller): 果実・蜜・黒曜石・星のかけらを集めてテラリウム・コアへ運搬する
   */
  private updateRootRoller(world: WorldGrid, sp: SpriteEntity): void {
    const gx = Math.round(sp.x);
    const gy = Math.round(sp.y);

    const isCollectible = (m: MatId) =>
      m === Mat.Fruit || m === Mat.Nectar || m === Mat.Obsidian || m === Mat.StarShard;

    if (sp.carrying === Mat.Air) {
      const nearItem = this.findNearbyMat(world, gx, gy, 2, isCollectible);
      if (nearItem && sp.cooldown === 0) {
        sp.carrying = world.getMat(nearItem.x, nearItem.y);
        world.setCell(nearItem.x, nearItem.y, Mat.Air);
        sp.state = 'deliver';
        sp.cooldown = 15;
      } else if (sp.animTick % 18 === 0) {
        const target = this.findNearbyMat(world, gx, gy, 36, isCollectible);
        if (target) {
          sp.state = 'seek';
          sp.targetX = target.x;
          sp.targetY = target.y;
        } else {
          sp.state = 'wander';
        }
      }
    } else {
      // 運搬先：コアがあればコアへ、なければ近くの発光キノコや植物の根元へ集積
      if (world.hasCore) {
        sp.targetX = world.coreX;
        sp.targetY = world.coreY;
        if (Math.abs(gx - world.coreX) <= 3 && Math.abs(gy - world.coreY) <= 3) {
          const kind =
            sp.carrying === Mat.Nectar
              ? 'nectar'
              : sp.carrying === Mat.Fruit
                ? 'fruit'
                : sp.carrying === Mat.Obsidian
                  ? 'obsidian'
                  : 'star_shard';
          world.onCoreDeliver?.(kind, 1);
          sp.carrying = Mat.Air;
          sp.state = 'wander';
          sp.cooldown = 20;
        }
      } else {
        // Cozy Mode でも120フレーム運んだら蜜は栄養土に変えるなど愛らしい行動をとる
        if (sp.animTick % 180 === 0 && world.getMat(gx, gy) === Mat.Air) {
          world.setCell(gx, gy, sp.carrying);
          sp.carrying = Mat.Air;
          sp.state = 'wander';
          sp.cooldown = 50;
        }
      }
    }

    this.moveGroundWalker(world, sp, 0.58);
  }

  /**
   * ピカリん (Spark-Bit): 空中を浮遊し、発電素子から電気を受け取って機械やコアへ供給する
   */
  private updateSparkBit(world: WorldGrid, sp: SpriteEntity): void {
    const gx = Math.round(sp.x);
    const gy = Math.round(sp.y);

    if (sp.energy <= 10) {
      // 帯電している発電箇所を探す
      const src = this.findNearbyChargedSource(world, gx, gy, 34);
      if (src) {
        sp.state = 'seek';
        sp.targetX = src.x;
        sp.targetY = src.y;
        if (Math.abs(gx - src.x) <= 2 && Math.abs(gy - src.y) <= 2) {
          sp.energy = 100;
          sp.state = 'deliver';
        }
      } else {
        sp.state = 'wander';
      }
    } else {
      // 放電先（未通電のポンプ・ゲート・蓄電池 または テラリウム・コア）を探す
      const sink = this.findPowerSink(world, gx, gy, 36);
      if (sink) {
        sp.state = 'deliver';
        sp.targetX = sink.x;
        sp.targetY = sink.y;
        if (Math.abs(gx - sink.x) <= 2 && Math.abs(gy - sink.y) <= 2) {
          const si = world.idx(sink.x, sink.y);
          const sMat = world.type[si];
          if (sMat === Mat.Core) {
            world.onCoreDeliver?.('power', 8);
          } else if (sMat === Mat.Battery) {
            world.meta[si] = Math.min(250, world.meta[si] + 45);
            world.charge[si] = 200;
          } else {
            world.charge[si] = 220;
          }
          sp.energy = 0;
          sp.state = 'wander';
        }
      } else {
        sp.energy = Math.max(0, sp.energy - 0.15);
        sp.state = 'wander';
      }
    }

    // 浮遊移動ロジック
    if (sp.state === 'wander') {
      if (sp.animTick % 40 === 0) {
        sp.targetX = Math.max(8, Math.min(WIDTH - 8, sp.x + (Math.random() - 0.5) * 32));
        sp.targetY = Math.max(12, Math.min(HEIGHT - 16, sp.y + (Math.random() - 0.5) * 20));
      }
    }

    const dx = sp.targetX - sp.x;
    const dy = sp.targetY - sp.y;
    const dist = Math.hypot(dx, dy) || 1;
    sp.vx = sp.vx * 0.85 + (dx / dist) * 0.16;
    sp.vy = sp.vy * 0.85 + (dy / dist) * 0.16 + Math.sin(sp.animTick * 0.12) * 0.04;
    if (Math.abs(sp.vx) > 0.05) sp.facing = sp.vx >= 0 ? 1 : -1;

    const nx = sp.x + sp.vx;
    const ny = sp.y + sp.vy;
    if (world.inBounds(Math.round(nx), Math.round(ny)) && !isSolidBlocking(world.getMat(Math.round(nx), Math.round(ny)))) {
      sp.x = nx;
      sp.y = ny;
    } else {
      sp.vx = -sp.vx * 0.6;
      sp.vy = -0.5;
    }
  }

  /**
   * 地上歩行スプライト（モフみず・コロねっこ）の物理移動＆1〜2段オートジャンプ
   */
  private moveGroundWalker(world: WorldGrid, sp: SpriteEntity, speed: number): void {
    if (sp.state === 'wander') {
      if (sp.animTick % 55 === 0) {
        sp.facing = Math.random() < 0.5 ? 1 : -1;
      }
      sp.vx = sp.facing * speed * 0.65;
    } else {
      const dx = sp.targetX - sp.x;
      if (Math.abs(dx) > 1) {
        sp.facing = dx >= 0 ? 1 : -1;
        sp.vx = sp.facing * speed;
      } else {
        sp.vx = 0;
      }
    }

    // 重力適用（水中では浮力でゆっくり泳ぐ）
    const curMat = world.getMat(Math.round(sp.x), Math.round(sp.y));
    if (curMat === Mat.Water) {
      sp.vy = Math.max(-0.6, sp.vy - 0.08);
    } else {
      sp.vy = Math.min(1.8, sp.vy + 0.16);
    }

    // 横移動と段差乗り越え（最大2セル高までの段差を自動でぴょんと登る）
    const nextX = Math.max(2, Math.min(WIDTH - 3, sp.x + sp.vx));
    const checkX = Math.round(nextX);
    const checkY = Math.round(sp.y);

    if (!this.isWalkBlocked(world, checkX, checkY)) {
      sp.x = nextX;
    } else if (!this.isWalkBlocked(world, checkX, checkY - 1)) {
      sp.x = nextX;
      sp.y -= 1;
      sp.vy = -0.3;
    } else if (!this.isWalkBlocked(world, checkX, checkY - 2)) {
      sp.x = nextX;
      sp.y -= 2;
      sp.vy = -0.4;
    } else {
      // 高い壁にぶつかったら反転または小ジャンプ
      if (sp.state === 'wander') {
        sp.facing = (sp.facing === 1 ? -1 : 1);
      } else if (this.isWalkBlocked(world, Math.round(sp.x), checkY + 1)) {
        sp.vy = -1.35;
      }
    }

    // 縦移動と着地判定
    const nextY = Math.max(2, Math.min(HEIGHT - 4, sp.y + sp.vy));
    if (!this.isWalkBlocked(world, Math.round(sp.x), Math.round(nextY))) {
      sp.y = nextY;
    } else {
      if (sp.vy > 0) {
        sp.y = Math.floor(sp.y);
      }
      sp.vy = 0;
    }
  }

  private isWalkBlocked(world: WorldGrid, x: number, y: number): boolean {
    const m = world.getMat(x, y);
    if (m === Mat.Air || m === Mat.Water || m === Mat.Steam || m === Mat.Spore || m === Mat.GateOpen) {
      return false;
    }
    // 葉や茎・キノコ・花はスプライトがすり抜けて歩けるようにする
    if (
      m === Mat.PlantStem ||
      m === Mat.Leaf ||
      m === Mat.Flower ||
      m === Mat.Mushroom ||
      m === Mat.VoltFern ||
      m === Mat.Fruit ||
      m === Mat.Nectar
    ) {
      return false;
    }
    return true;
  }

  private findNearbyMat(
    world: WorldGrid,
    cx: number,
    cy: number,
    radius: number,
    predicate: (mat: MatId) => boolean
  ): { x: number; y: number } | null {
    let bestX = -1;
    let bestY = -1;
    let bestDist = Infinity;

    const minY = Math.max(1, cy - radius);
    const maxY = Math.min(HEIGHT - 2, cy + radius);
    const minX = Math.max(1, cx - radius);
    const maxX = Math.min(WIDTH - 2, cx + radius);

    for (let y = minY; y <= maxY; y++) {
      const row = y << 8;
      for (let x = minX; x <= maxX; x++) {
        const m = world.type[row + x] as MatId;
        if (predicate(m)) {
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bestDist) {
            bestDist = d;
            bestX = x;
            bestY = y;
          }
        }
      }
    }

    return bestX !== -1 ? { x: bestX, y: bestY } : null;
  }

  private findNearbyChargedSource(
    world: WorldGrid,
    cx: number,
    cy: number,
    radius: number
  ): { x: number; y: number } | null {
    const minY = Math.max(1, cy - radius);
    const maxY = Math.min(HEIGHT - 2, cy + radius);
    const minX = Math.max(1, cx - radius);
    const maxX = Math.min(WIDTH - 2, cx + radius);

    for (let y = minY; y <= maxY; y++) {
      const row = y << 8;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        const m = world.type[i];
        if (
          (m === Mat.VoltFern || m === Mat.RotorHub || m === Mat.Copper || m === Mat.StarShard) &&
          world.charge[i] >= 45
        ) {
          return { x, y };
        }
      }
    }
    return null;
  }

  private findPowerSink(
    world: WorldGrid,
    cx: number,
    cy: number,
    radius: number
  ): { x: number; y: number } | null {
    // コアがあれば優先候補に入れつつ、近くの未通電ポンプ・蓄電池・ゲートも探す
    const minY = Math.max(1, cy - radius);
    const maxY = Math.min(HEIGHT - 2, cy + radius);
    const minX = Math.max(1, cx - radius);
    const maxX = Math.min(WIDTH - 2, cx + radius);

    for (let y = minY; y <= maxY; y++) {
      const row = y << 8;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        const m = world.type[i];
        if ((m === Mat.Pump || m === Mat.GateClosed) && world.charge[i] < 35) {
          return { x, y };
        }
        if (m === Mat.Battery && world.meta[i] < 200) {
          return { x, y };
        }
      }
    }

    if (world.hasCore) {
      return { x: world.coreX, y: world.coreY };
    }
    return null;
  }

  /**
   * ライティング用の発光座標リストを生成して返す
   */
  getLightSources(world: WorldGrid): ReadonlyArray<{ x: number; y: number; r: number; g: number; b: number }> {
    this.lightPoints.length = 0;
    for (let i = 0; i < this.sprites.length; i++) {
      const sp = this.sprites[i];
      if (sp.kind === 'spark_bit') {
        const intensity = sp.energy > 10 ? 1.0 : 0.55;
        this.lightPoints.push({
          x: sp.x | 0,
          y: sp.y | 0,
          r: (255 * intensity) | 0,
          g: (235 * intensity) | 0,
          b: (120 * intensity) | 0,
        });
      } else if (sp.kind === 'aqua_puff') {
        this.lightPoints.push({
          x: sp.x | 0,
          y: sp.y | 0,
          r: 35,
          g: 120,
          b: 185,
        });
      }
    }

    // 夜間には森の上を舞う幻想的なホタルの光を追加
    if (world.isNight()) {
      for (let f = 0; f < 6; f++) {
        const fx = ((Math.sin(world.tick * 0.013 + f * 2.1) * 0.42 + 0.5) * WIDTH) | 0;
        const fy = (52 + Math.cos(world.tick * 0.019 + f * 1.7) * 22) | 0;
        this.lightPoints.push({ x: fx, y: fy, r: 130, g: 220, b: 95 });
      }
    }

    return this.lightPoints;
  }

  /**
   * オフスクリーン Canvas (256x144) にベビーシェマに基づく丸いドット絵キャラクターを描画する
   */
  render(ctx: CanvasRenderingContext2D, world: WorldGrid): void {
    for (let i = 0; i < this.sprites.length; i++) {
      const sp = this.sprites[i];
      const bounce = (sp.animTick >> 3) & 1;
      const sx = Math.round(sp.x);
      const sy = Math.round(sp.y) - bounce;

      if (sp.kind === 'aqua_puff') {
        // モフみず：水色のぷにぷにしずく型ボディ (3x3) + 白いハイライト + つぶらな目
        ctx.fillStyle = '#5ad2ff';
        ctx.fillRect(sx - 1, sy - 2, 3, 3);
        ctx.fillStyle = '#bdf2ff';
        ctx.fillRect(sx, sy - 3, 1, 1);
        ctx.fillStyle = '#142638';
        ctx.fillRect(sx + (sp.facing > 0 ? 1 : -1), sy - 1, 1, 1);
        if (sp.carrying === Mat.Water) {
          ctx.fillStyle = '#2da8ff';
          ctx.fillRect(sx, sy - 4, 2, 2);
        }
      } else if (sp.kind === 'root_roller') {
        // コロねっこ：温かい木の実ブラウンの丸ボディ + 頭の双葉 + 運搬アイテム表示
        ctx.fillStyle = '#c88c52';
        ctx.fillRect(sx - 1, sy - 2, 3, 3);
        ctx.fillStyle = '#78dc5a';
        ctx.fillRect(sx, sy - 3, 2, 1);
        ctx.fillStyle = '#24160e';
        ctx.fillRect(sx + (sp.facing > 0 ? 1 : -1), sy - 1, 1, 1);
        if (sp.carrying !== Mat.Air) {
          ctx.fillStyle =
            sp.carrying === Mat.Nectar
              ? '#ffd23c'
              : sp.carrying === Mat.Fruit
                ? '#ff5264'
                : sp.carrying === Mat.Obsidian
                  ? '#6848a8'
                  : '#fff4a8';
          ctx.fillRect(sx - 1, sy - 4, 2, 2);
        }
      } else {
        // ピカリん：輝く黄金スターボディ + パタパタ羽根
        ctx.fillStyle = sp.energy > 10 ? '#fff275' : '#e6be5a';
        ctx.fillRect(sx - 1, sy - 1, 3, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx, sy - 2, 1, 1);
        if ((sp.animTick & 2) === 0) {
          ctx.fillStyle = '#aef6ff';
          ctx.fillRect(sx - 2, sy - 2, 1, 1);
          ctx.fillRect(sx + 2, sy - 2, 1, 1);
        }
      }
    }

    // 夜間のホタルドット描画
    if (world.isNight()) {
      ctx.fillStyle = '#d8ff8a';
      for (let f = 0; f < 6; f++) {
        if (((world.tick >> 3) + f) % 3 === 0) continue;
        const fx = ((Math.sin(world.tick * 0.013 + f * 2.1) * 0.42 + 0.5) * WIDTH) | 0;
        const fy = (52 + Math.cos(world.tick * 0.019 + f * 1.7) * 22) | 0;
        ctx.fillRect(fx, fy, 1, 1);
      }
    }
  }
}

