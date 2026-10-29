import { BgMat, BgMatId, Mat, MatId } from '../core/materials';
import { FLAG_INDESTRUCTIBLE, FLAG_NO_BRUSH, WorldGrid } from '../core/world';
import { ProgressionManager } from '../modes/alchemist';
import { deployRotorBlades, updateWoodBridgesInRegion } from '../systems/building';

export interface BlueprintData {
  id: string;
  name: string;
  width: number;
  height: number;
  types: number[];
  metas: number[];
  bgTypes: number[];
}

const STORAGE_KEY = 'terra_weave_blueprints_v1';

/**
 * 範囲選択によるブループリント（モジュール保存＆ワンクリックスタンプ配置）管理クラス (Phase 4)
 */
export class BlueprintManager {
  blueprints: BlueprintData[] = [];
  activeBlueprintId: string | null = null;

  constructor() {
    this.loadFromStorage();
    if (this.blueprints.length === 0) {
      this.blueprints = createBuiltinBlueprints();
    }
  }

  getActive(): BlueprintData | null {
    if (!this.activeBlueprintId) return null;
    return this.blueprints.find((b) => b.id === this.activeBlueprintId) ?? null;
  }

  /**
   * ワールド内の矩形範囲 [x1,y1]〜[x2,y2] をキャプチャしてブループリントとして保存する
   */
  captureRegion(
    world: WorldGrid,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    name: string
  ): BlueprintData | null {
    const minX = Math.max(0, Math.min(x1, x2));
    const maxX = Math.min(world.width - 1, Math.max(x1, x2));
    const minY = Math.max(0, Math.min(y1, y2));
    const maxY = Math.min(world.height - 1, Math.max(y1, y2));

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < 2 || h < 2 || w > 80 || h > 60) return null;

    const types: number[] = [];
    const metas: number[] = [];
    const bgTypes: number[] = [];
    let nonEmpty = 0;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = world.idx(x, y);
        const t = world.type[i] === Mat.Core ? Mat.Air : world.type[i];
        const bg = world.bgType[i] === BgMat.CoreTree ? BgMat.None : world.bgType[i];
        if (t !== Mat.Air || bg !== BgMat.None) nonEmpty++;
        types.push(t);
        metas.push(world.meta[i]);
        bgTypes.push(bg);
      }
    }

    if (nonEmpty === 0) return null;

    const bp: BlueprintData = {
      id: `bp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name,
      width: w,
      height: h,
      types,
      metas,
      bgTypes,
    };

    this.blueprints.unshift(bp);
    if (this.blueprints.length > 12) {
      this.blueprints.pop();
    }
    this.saveToStorage();
    return bp;
  }

  /**
   * ブループリントを中心座標 (cx, cy) にスタンプ配置する
   * Alchemist Mode では未解放マテリアルやコア保護エリアを自動尊重する
   */
  stamp(
    world: WorldGrid,
    bp: BlueprintData,
    cx: number,
    cy: number,
    progression: ProgressionManager
  ): number {
    const startX = cx - (bp.width >> 1);
    const startY = cy - (bp.height >> 1);
    let placed = 0;

    for (let ly = 0; ly < bp.height; ly++) {
      for (let lx = 0; lx < bp.width; lx++) {
        const gx = startX + lx;
        const gy = startY + ly;
        if (!world.inBounds(gx, gy)) continue;

        const gi = world.idx(gx, gy);
        if ((world.flags[gi] & FLAG_INDESTRUCTIBLE) !== 0) continue;
        if (progression.mode === 'alchemist' && (world.flags[gi] & FLAG_NO_BRUSH) !== 0) continue;

        const idx = ly * bp.width + lx;
        const mat = bp.types[idx] as MatId;
        const bg = bp.bgTypes[idx] as BgMatId;

        if (mat !== Mat.Air && progression.isBrushUnlocked(mat)) {
          world.setCell(gx, gy, mat, bp.metas[idx]);
          if (mat === Mat.RotorHub) {
            deployRotorBlades(world, gx, gy);
          }
          placed++;
        }
        if (bg !== BgMat.None && world.bgType[gi] === BgMat.None) {
          world.setBg(gx, gy, bg, 0);
        }
      }
    }

    if (placed > 0) {
      updateWoodBridgesInRegion(
        world,
        Math.max(1, startX - 2),
        Math.min(world.width - 2, startX + bp.width + 2),
        cy
      );
    }

    return placed;
  }

  deleteBlueprint(id: string): void {
    this.blueprints = this.blueprints.filter((b) => b.id !== id);
    if (this.activeBlueprintId === id) {
      this.activeBlueprintId = null;
    }
    this.saveToStorage();
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as BlueprintData[];
        if (Array.isArray(parsed)) {
          this.blueprints = parsed;
        }
      }
    } catch {
      // ストレージ利用不可時は無視
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.blueprints));
    } catch {
      // クォータ超過時は無視
    }
  }
}

/** 最初からすぐ試せるプリセット・ブループリント（温室ドーム＆蒸気風車タワー） */
function createBuiltinBlueprints(): BlueprintData[] {
  // 1. ガラス温室ドーム (11x7)
  const w1 = 11;
  const h1 = 7;
  const t1 = new Array<number>(w1 * h1).fill(Mat.Air);
  const m1 = new Array<number>(w1 * h1).fill(0);
  const bg1 = new Array<number>(w1 * h1).fill(BgMat.None);
  for (let x = 0; x < w1; x++) {
    t1[(h1 - 1) * w1 + x] = Mat.Wood;
    if (x >= 2 && x <= w1 - 3) {
      t1[(h1 - 2) * w1 + x] = Mat.WetSoil;
      m1[(h1 - 2) * w1 + x] = 180;
    }
  }
  // ガラスのアーチ屋根
  const domeCoords: [number, number][] = [
    [1, 5], [1, 4], [1, 3], [2, 2], [3, 1], [4, 0], [5, 0], [6, 0], [7, 1], [8, 2], [9, 3], [9, 4], [9, 5],
  ];
  for (const [dx, dy] of domeCoords) {
    t1[dy * w1 + dx] = Mat.Glass;
  }
  t1[4 * w1 + 5] = Mat.Seed;

  // 2. 水車・風車発電ユニット (7x7)
  const w2 = 7;
  const h2 = 7;
  const t2 = new Array<number>(w2 * h2).fill(Mat.Air);
  const m2 = new Array<number>(w2 * h2).fill(0);
  const bg2 = new Array<number>(w2 * h2).fill(BgMat.None);
  t2[3 * w2 + 3] = Mat.RotorHub;
  for (let x = 3; x < w2; x++) {
    if (x !== 3) t2[3 * w2 + x] = Mat.Copper;
  }
  bg2[4 * w2 + 1] = BgMat.WoodPillar;
  bg2[5 * w2 + 1] = BgMat.WoodPillar;
  bg2[6 * w2 + 1] = BgMat.WoodPillar;
  bg2[4 * w2 + 5] = BgMat.WoodPillar;
  bg2[5 * w2 + 5] = BgMat.WoodPillar;
  bg2[6 * w2 + 5] = BgMat.WoodPillar;

  return [
    {
      id: 'preset_greenhouse',
      name: 'Glass Greenhouse',
      width: w1,
      height: h1,
      types: t1,
      metas: m1,
      bgTypes: bg1,
    },
    {
      id: 'preset_rotor',
      name: 'Rotor Generator',
      width: w2,
      height: h2,
      types: t2,
      metas: m2,
      bgTypes: bg2,
    },
  ];
}

