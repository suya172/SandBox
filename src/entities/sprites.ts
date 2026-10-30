import { isSolidBlocking, Mat, MatId } from '../core/materials';
import { HEIGHT, WIDTH, WorldGrid } from '../core/world';

export type SpriteKind = 'aqua_puff' | 'root_roller' | 'spark_bit' | 'shade_mite';
export type SpriteState = 'wander' | 'seek' | 'deliver';

export interface SpriteEntity {
  active: boolean;
  id: number;
  kind: SpriteKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  state: SpriteState;
  carrying: MatId;     // 運搬中のマテリアル（Air なら未所持）
  energy: number;      // ピカリんの帯電量 または カゲむしの光照射ストレス値
  targetX: number;
  targetY: number;
  animTick: number;
  cooldown: number;
}

export const MAX_ALLIES = 80;
export const MAX_MITES = 64;
export const POOL_SIZE = MAX_ALLIES + MAX_MITES; // 144 固定スロット

/**
 * 自律型精霊「スプライト (Sprites)」＆夜行性「カゲむし (Shade-Mite)」管理クラス
 * 60FPS維持のため、事前確保した固定長スロットプール (144枠) で new / splice ゼロで動作する
 */
export class SpriteManager {
  private readonly pool: SpriteEntity[] = [];
  /** アクティブなエンティティの読み取り専用キャッシュ配列（毎フレーム再利用・GCゼロ） */
  readonly sprites: SpriteEntity[] = [];
  private nextId = 1;

  // ライティングシステムへ渡す動的光源配列（事前確保オブジェクトを再利用）
  private readonly lightPoints: { x: number; y: number; r: number; g: number; b: number }[] = [];
  private readonly lightPool: { x: number; y: number; r: number; g: number; b: number }[] = [];

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push({
        active: false,
        id: 0,
        kind: 'aqua_puff',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        facing: 1,
        state: 'wander',
        carrying: Mat.Air,
        energy: 0,
        targetX: 0,
        targetY: 0,
        animTick: 0,
        cooldown: 0,
      });
    }
    for (let i = 0; i < POOL_SIZE + 8; i++) {
      this.lightPool.push({ x: 0, y: 0, r: 0, g: 0, b: 0 });
    }
  }

  clear(): void {
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool[i].active = false;
    }
    this.sprites.length = 0;
  }

  /** カゲむし（敵対種）のみを一括消去する（日の出リトライ時など） */
  clearMites(): void {
    for (let i = MAX_ALLIES; i < POOL_SIZE; i++) {
      this.pool[i].active = false;
    }
    this.rebuildActiveView();
  }

  /** 指定種のエンティティを事前確保プールから起動してスポーンさせる */
  spawn(kind: SpriteKind, x: number, y: number): SpriteEntity | null {
    const startIdx = kind === 'shade_mite' ? MAX_ALLIES : 0;
    const endIdx = kind === 'shade_mite' ? POOL_SIZE : MAX_ALLIES;

    for (let i = startIdx; i < endIdx; i++) {
      const sp = this.pool[i];
      if (!sp.active) {
        sp.active = true;
        sp.id = this.nextId++;
        sp.kind = kind;
        sp.x = x;
        sp.y = y;
        sp.vx = 0;
        sp.vy = 0;
        sp.facing = worldRngFlip(this.nextId + ((x + y) | 0));
        sp.state = 'wander';
        sp.carrying = Mat.Air;
        sp.energy = 0;
        sp.targetX = x;
        sp.targetY = y;
        sp.animTick = ((this.nextId * 17) & 63);
        sp.cooldown = 0;
        this.sprites.push(sp);
        return sp;
      }
    }
    return null;
  }

  /** 種類ごとの現在アクティブ個体数を集計 */
  countByKind(): Record<SpriteKind, number> {
    const counts: Record<SpriteKind, number> = {
      aqua_puff: 0,
      root_roller: 0,
      spark_bit: 0,
      shade_mite: 0,
    };
    for (let i = 0; i < POOL_SIZE; i++) {
      const sp = this.pool[i];
      if (sp.active) {
        counts[sp.kind]++;
      }
    }
    return counts;
  }

  /** 味方スプライトの合計個体数 */
  countAllies(): number {
    let n = 0;
    for (let i = 0; i < MAX_ALLIES; i++) {
      if (this.pool[i].active) n++;
    }
    return n;
  }

  /** カゲむしの現在アクティブ個体数 */
  countMites(): number {
    let n = 0;
    for (let i = MAX_ALLIES; i < POOL_SIZE; i++) {
      if (this.pool[i].active) n++;
    }
    return n;
  }

  private rebuildActiveView(): void {
    this.sprites.length = 0;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this.pool[i].active) {
        this.sprites.push(this.pool[i]);
      }
    }
  }

  /**
   * 1フレーム分の自然スポーン判定と全アクティブエンティティのFSM行動更新
   */
  update(world: WorldGrid): void {
    // 光源マップが未更新のヘッドレス環境でもカゲむしが光判定できるよう定期同期
    if ((world.tick & 7) === 0) {
      world.updateLightField(this.getLightSources(world));
    }

    // 45フレームに1回、環境条件を満たしていれば味方スプライトの自然スポーンを試みる
    if (world.tick % 45 === 0 && this.countAllies() < MAX_ALLIES) {
      this.tryNaturalSpawn(world);
    }

    let anyRemoved = false;

    for (let i = 0; i < POOL_SIZE; i++) {
      const sp = this.pool[i];
      if (!sp.active) continue;

      sp.animTick++;
      if (sp.cooldown > 0) sp.cooldown--;

      if (sp.kind === 'shade_mite') {
        this.updateShadeMite(world, sp);
        if (!sp.active) anyRemoved = true;
        continue;
      }

      // 味方スプライト：溶岩などの極端な高温セルに巻き込まれた場合は退避ジャンプ
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
      if (!sp.active) anyRemoved = true;
    }

    if (anyRemoved) {
      this.rebuildActiveView();
    }
  }

  /**
   * 箱庭の生態系条件に応じた味方スプライトの自然スポーンチェック
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
   * 夜行性襲撃スプライト「カゲむし (Shade-Mite)」の行動・光忌避・トラップ撃退更新
   * A* 経路探索は行わず、64x36 ライトマップ輝度勾配と局所セル参照のみで O(1) 動作する
   */
  private updateShadeMite(world: WorldGrid, sp: SpriteEntity): void {
    const gx = Math.max(1, Math.min(WIDTH - 2, Math.round(sp.x)));
    const gy = Math.max(1, Math.min(HEIGHT - 2, Math.round(sp.y)));
    const cellIdx = world.idx(gx, gy);

    // 1. 日の出による自然霧散（地下洞窟の完全暗所以外）
    if (!world.isNight() && world.getDaylightFactor() > 0.54 && world.bgType[cellIdx] === 0) {
      if (world.rng.chance(0.12)) {
        sp.active = false;
        return;
      }
    }

    // 2. 高熱（炎・蒸気・溶岩）または帯電ブロック（電撃フェンス・雷）による即時撃退と資源ドロップ
    let electrocuted = false;
    let burned = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (!world.inBounds(nx, ny)) continue;
        const ni = world.idx(nx, ny);
        const nm = world.type[ni];
        if (nm === Mat.Core) continue;
        if (world.charge[ni] >= 55 || nm === Mat.Lightning) {
          electrocuted = true;
          break;
        }
        if (world.temp[ni] >= 140 || nm === Mat.Fire || nm === Mat.Magma) {
          burned = true;
          break;
        }
      }
      if (electrocuted || burned) break;
    }

    if (electrocuted || burned) {
      sp.active = false;
      // 撃退ボーナス：現在地または直上の空きセルに浄化灰・星のかけらをドロップ（自動回収ラインで資源化可能）
      const dropOffsets: readonly [number, number][] = [
        [0, 0],
        [0, -1],
        [-1, 0],
        [1, 0],
      ];
      for (let k = 0; k < dropOffsets.length; k++) {
        const dx = gx + dropOffsets[k][0];
        const dy = gy + dropOffsets[k][1];
        if (!world.inBounds(dx, dy)) continue;
        if (world.type[world.idx(dx, dy)] === Mat.Air) {
          if (electrocuted && (world.dayCount >= 8 || world.rng.chance(0.28))) {
            world.setCell(dx, dy, Mat.StarShard, 0, 35);
          } else if (electrocuted || world.rng.chance(0.75)) {
            world.setCell(dx, dy, Mat.Ash, 0, 35);
          }
          break;
        }
      }
      return;
    }

    // 3. テラリウム・コア到達時の耐久値 (Vitality) 吸収攻撃
    if (world.hasCore) {
      if (Math.abs(gx - world.coreX) <= 3 && Math.abs(gy - world.coreY) <= 3) {
        world.damageCore(4);
        sp.active = false;
        return;
      }
    }

    // 4. 64x36 ライトマップ勾配を用いた光忌避ベクトル計算
    const goalX = world.hasCore ? world.coreX : WIDTH >> 1;
    const goalDir: 1 | -1 = goalX >= sp.x ? 1 : -1;

    const lumaHere = world.getLightAt(gx, gy);
    const lumaAhead = world.getLightAt(gx + goalDir * 5, gy);
    const lumaBehind = world.getLightAt(gx - goalDir * 5, gy);
    const maxLuma = lumaHere > lumaAhead ? lumaHere : lumaAhead;

    // 強い光源（焚き火・発光キノコ・ピカリん等）に照らされると怯んで後退する
    if (maxLuma >= 62) {
      sp.energy += maxLuma >= 110 ? 5 : 3;
      // 光が弱い背後方向へ逃げ返す
      const fleeDir: 1 | -1 = lumaAhead >= lumaBehind ? (-goalDir as 1 | -1) : goalDir;
      sp.facing = fleeDir;
      sp.state = 'wander';
      if (sp.cooldown === 0 && this.isWalkBlocked(world, gx, gy + 1)) {
        sp.vy = -0.85;
        sp.cooldown = 18;
      }
      // 強い光に照射され続けた場合は浄化消散
      if (sp.energy >= 90) {
        sp.active = false;
        if (world.type[cellIdx] === Mat.Air && world.rng.chance(0.45)) {
          world.setCell(gx, gy, Mat.Ash, 0, 26);
        }
        return;
      }
    } else {
      sp.energy = Math.max(0, sp.energy - 1);
      sp.state = 'seek';
      sp.targetX = goalX;
      sp.targetY = world.hasCore ? world.coreY : gy;
      sp.facing = goalDir;
    }

    // 5. 道中の植物食害および Phase II (Day 4+) 以降の木壁かじり
    if (sp.cooldown === 0) {
      const frontX = gx + sp.facing;
      for (let dy = -1; dy <= 1; dy++) {
        const fy = gy + dy;
        if (!world.inBounds(frontX, fy)) continue;
        const fm = world.getMat(frontX, fy);
        if (fm === Mat.PlantStem || fm === Mat.Leaf || fm === Mat.Flower || fm === Mat.Seed) {
          world.setCell(frontX, fy, Mat.Air);
          sp.cooldown = 22;
          break;
        }
        // Day 4 以降は木の壁も少しずつかじって突破を試みる（石材・ガラス・自動ゲートは突破不可）
        if (fm === Mat.Wood && world.dayCount >= 4 && world.rng.chance(0.18)) {
          world.setCell(frontX, fy, Mat.Air);
          sp.cooldown = 35;
          break;
        }
      }
    }

    this.moveGroundWalker(world, sp, sp.state === 'wander' ? 0.62 : 0.48);
  }

  /**
   * モフみず (Aqua-Puff): 水を吸って火災消火・乾燥土の灌漑・コアへの水納品を行う
   */
  private updateAquaPuff(world: WorldGrid, sp: SpriteEntity): void {
    const gx = Math.round(sp.x);
    const gy = Math.round(sp.y);

    if (sp.carrying === Mat.Air) {
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
            world.healCore(1);
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
          world.healCore(1);
          sp.carrying = Mat.Air;
          sp.state = 'wander';
          sp.cooldown = 20;
        }
      } else {
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
            world.healCore(1);
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

    if (sp.state === 'wander') {
      if (sp.animTick % 40 === 0) {
        sp.targetX = Math.max(8, Math.min(WIDTH - 8, sp.x + (world.rng.next() - 0.5) * 32));
        sp.targetY = Math.max(12, Math.min(HEIGHT - 16, sp.y + (world.rng.next() - 0.5) * 20));
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
    if (
      world.inBounds(Math.round(nx), Math.round(ny)) &&
      !isSolidBlocking(world.getMat(Math.round(nx), Math.round(ny)))
    ) {
      sp.x = nx;
      sp.y = ny;
    } else {
      sp.vx = -sp.vx * 0.6;
      sp.vy = -0.5;
    }
  }

  /**
   * 地上歩行エンティティ（モフみず・コロねっこ・カゲむし）の物理移動＆1〜2段オートジャンプ
   */
  private moveGroundWalker(world: WorldGrid, sp: SpriteEntity, speed: number): void {
    if (sp.state === 'wander') {
      if (sp.kind !== 'shade_mite' && sp.animTick % 55 === 0) {
        sp.facing = world.rng.chance(0.5) ? 1 : -1;
      }
      sp.vx = sp.facing * speed * (sp.kind === 'shade_mite' ? 1.0 : 0.65);
    } else {
      const dx = sp.targetX - sp.x;
      if (Math.abs(dx) > 1) {
        sp.facing = dx >= 0 ? 1 : -1;
        sp.vx = sp.facing * speed;
      } else {
        sp.vx = 0;
      }
    }

    const curMat = world.getMat(Math.round(sp.x), Math.round(sp.y));
    if (curMat === Mat.Water || curMat === Mat.BlightWater) {
      sp.vy = Math.max(-0.6, sp.vy - 0.08);
    } else {
      sp.vy = Math.min(1.8, sp.vy + 0.16);
    }

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
      if (sp.state === 'wander' && sp.kind !== 'shade_mite') {
        sp.facing = sp.facing === 1 ? -1 : 1;
      } else if (this.isWalkBlocked(world, Math.round(sp.x), checkY + 1)) {
        sp.vy = -1.35;
      }
    }

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
    if (
      m === Mat.Air ||
      m === Mat.Water ||
      m === Mat.BlightWater ||
      m === Mat.Steam ||
      m === Mat.Spore ||
      m === Mat.Miasma ||
      m === Mat.GateOpen
    ) {
      return false;
    }
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
   * ライティング用の発光座標リストを事前確保プールから書き出して返す（GCゼロ）
   */
  getLightSources(
    world: WorldGrid
  ): ReadonlyArray<{ x: number; y: number; r: number; g: number; b: number }> {
    this.lightPoints.length = 0;
    let poolIdx = 0;

    const pushLight = (x: number, y: number, r: number, g: number, b: number) => {
      if (poolIdx >= this.lightPool.length) return;
      const item = this.lightPool[poolIdx++];
      item.x = x;
      item.y = y;
      item.r = r;
      item.g = g;
      item.b = b;
      this.lightPoints.push(item);
    };

    for (let i = 0; i < MAX_ALLIES; i++) {
      const sp = this.pool[i];
      if (!sp.active) continue;
      if (sp.kind === 'spark_bit') {
        const intensity = sp.energy > 10 ? 1.0 : 0.6;
        pushLight(
          sp.x | 0,
          sp.y | 0,
          (255 * intensity) | 0,
          (235 * intensity) | 0,
          (120 * intensity) | 0
        );
      } else if (sp.kind === 'aqua_puff') {
        pushLight(sp.x | 0, sp.y | 0, 35, 120, 185);
      }
    }

    if (world.isNight()) {
      for (let f = 0; f < 6; f++) {
        const fx = ((Math.sin(world.tick * 0.013 + f * 2.1) * 0.42 + 0.5) * WIDTH) | 0;
        const fy = (52 + Math.cos(world.tick * 0.019 + f * 1.7) * 22) | 0;
        pushLight(fx, fy, 95, 165, 70);
      }
    }

    return this.lightPoints;
  }

  /**
   * オフスクリーン Canvas (256x144) に味方スプライト3種と夜行性カゲむしを描画する
   */
  render(ctx: CanvasRenderingContext2D, world: WorldGrid): void {
    for (let i = 0; i < POOL_SIZE; i++) {
      const sp = this.pool[i];
      if (!sp.active) continue;

      const bounce = (sp.animTick >> 3) & 1;
      const sx = Math.round(sp.x);
      const sy = Math.round(sp.y) - bounce;

      if (sp.kind === 'aqua_puff') {
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
      } else if (sp.kind === 'spark_bit') {
        ctx.fillStyle = sp.energy > 10 ? '#fff275' : '#e6be5a';
        ctx.fillRect(sx - 1, sy - 1, 3, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx, sy - 2, 1, 1);
        if ((sp.animTick & 2) === 0) {
          ctx.fillStyle = '#aef6ff';
          ctx.fillRect(sx - 2, sy - 2, 1, 1);
          ctx.fillRect(sx + 2, sy - 2, 1, 1);
        }
      } else {
        // カゲむし (Shade-Mite): 丸みのある暗紫の影ボディ + 小さな角突起 + 淡く光る単眼
        ctx.fillStyle = '#241830';
        ctx.fillRect(sx - 1, sy - 2, 3, 2);
        ctx.fillStyle = '#3d2852';
        ctx.fillRect(sx, sy - 3, 1, 1);
        // 脚のちょこちょこ動き
        const legShift = (sp.animTick >> 2) & 1;
        ctx.fillStyle = '#181022';
        ctx.fillRect(sx - 1 + legShift, sy, 1, 1);
        ctx.fillRect(sx + 1 - legShift, sy, 1, 1);
        // 光に怯えている時は単眼が黄色、侵攻時は不気味な珊瑚赤に光る
        ctx.fillStyle = sp.energy > 20 ? '#d6a45f' : '#e8685a';
        ctx.fillRect(sx + (sp.facing > 0 ? 1 : -1), sy - 2, 1, 1);
      }
    }

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

function worldRngFlip(seedLike: number): 1 | -1 {
  return (seedLike & 1) === 0 ? 1 : -1;
}
