import { MATERIALS, MAT_COUNT, MAT_HARDNESS, Mat, MatId } from '../core/materials';
import { GameMode } from '../core/terrainGen';
import { FLAG_INDESTRUCTIBLE, FLAG_RUIN, WorldGrid } from '../core/world';

export type ToolTier = 1 | 2 | 3 | 4;
export type DeliveryKind = 'water' | 'nectar' | 'fruit' | 'power' | 'obsidian' | 'star_shard';

export interface TierMilestoneView {
  tier: ToolTier;
  titleKey: string;
  descKey: string;
  lawKey: string;
  bars: { labelKey: string; current: number; target: number }[];
  nextUnlockMats: MatId[];
}

/** Cozy Toy Mode でパレットに表示する全ブラシ一覧 */
export const ALL_PLAYABLE_BRUSHES: readonly MatId[] = [
  Mat.Air,
  Mat.Water,
  Mat.Soil,
  Mat.Sand,
  Mat.Stone,
  Mat.HardStone,
  Mat.BlightSoil,
  Mat.BlightWater,
  Mat.Seed,
  Mat.Mushroom,
  Mat.Wood,
  Mat.Glass,
  Mat.Copper,
  Mat.VoltFern,
  Mat.RotorHub,
  Mat.Pipe,
  Mat.Pump,
  Mat.Battery,
  Mat.GateClosed,
  Mat.Sensor,
  Mat.WeatherAntenna,
  Mat.Fire,
  Mat.Magma,
  Mat.Lightning,
  Mat.Steam,
  Mat.Miasma,
  Mat.Nectar,
  Mat.Obsidian,
  Mat.StarShard,
];

/** Alchemist Mode のティア別解放マテリアル定義 (SPEC 3.3) */
export const TIER_BRUSH_GROUPS: Record<ToolTier, readonly MatId[]> = {
  1: [Mat.Water, Mat.Soil, Mat.Sand, Mat.Seed, Mat.Wood, Mat.Fire],
  2: [Mat.Stone, Mat.Glass, Mat.Mushroom],
  3: [
    Mat.Copper,
    Mat.VoltFern,
    Mat.RotorHub,
    Mat.Pipe,
    Mat.Pump,
    Mat.Battery,
    Mat.GateClosed,
    Mat.Sensor,
  ],
  4: [Mat.Magma, Mat.Lightning, Mat.WeatherAntenna],
};

/** Alchemist Mode パレットに並べる全対象ブラシ */
export const ALCHEMIST_PALETTE_BRUSHES: readonly MatId[] = [
  Mat.Air, // 吸引 / 掘削ツール (Harvest)
  ...TIER_BRUSH_GROUPS[1],
  ...TIER_BRUSH_GROUPS[2],
  ...TIER_BRUSH_GROUPS[3],
  ...TIER_BRUSH_GROUPS[4],
];

export interface ProgressionStats {
  waterDelivered: number;
  bioDelivered: number;
  powerDelivered: number;
  glassCollected: number;
  copperCollected: number;
  obsidianCollected: number;
  starShardCollected: number;
}

interface DawnProgressionSnap {
  valid: boolean;
  toolTier: ToolTier;
  raidsEnabled: boolean;
  stock: Uint32Array;
  infiniteMask: Uint8Array;
  stats: ProgressionStats;
}

/**
 * Alchemist Mode 2.0 進行・ハイブリッド採取ストック・4段階ツールティア管理クラス
 */
export class ProgressionManager {
  mode: GameMode = 'cozy';
  toolTier: ToolTier = 1;
  raidsEnabled: boolean = true;

  /** マテリアル別の所持ストック数（固定長 TypedArray） */
  readonly stock = new Uint32Array(64);
  /** インフラ構築により無限供給 (INF) になったマテリアルのマスク (1 = INF) */
  readonly infiniteMask = new Uint8Array(64);

  stats: ProgressionStats = {
    waterDelivered: 0,
    bioDelivered: 0,
    powerDelivered: 0,
    glassCollected: 0,
    copperCollected: 0,
    obsidianCollected: 0,
    starShardCollected: 0,
  };

  private floraHarvestCounter: number = 0;

  private readonly dawnSnap: DawnProgressionSnap = {
    valid: false,
    toolTier: 1,
    raidsEnabled: true,
    stock: new Uint32Array(64),
    infiniteMask: new Uint8Array(64),
    stats: {
      waterDelivered: 0,
      bioDelivered: 0,
      powerDelivered: 0,
      glassCollected: 0,
      copperCollected: 0,
      obsidianCollected: 0,
      starShardCollected: 0,
    },
  };

  onDeliver?: (kind: DeliveryKind, amount: number) => void;
  onTierUnlocked?: (newTier: ToolTier, newlyUnlocked: MatId[]) => void;
  onInfiniteUnlocked?: (mat: MatId) => void;

  constructor(mode: GameMode = 'cozy') {
    this.reset(mode);
  }

  /** 後方互換用ステージ番号ゲッター (1..4 = Tier 1..4) */
  get stage(): number {
    return this.toolTier;
  }

  set stage(v: number) {
    this.toolTier = Math.max(1, Math.min(4, v | 0)) as ToolTier;
  }

  reset(mode: GameMode): void {
    this.mode = mode;
    this.toolTier = 1;
    this.raidsEnabled = true;
    this.stock.fill(0);
    this.infiniteMask.fill(0);
    this.floraHarvestCounter = 0;
    this.stats = {
      waterDelivered: 0,
      bioDelivered: 0,
      powerDelivered: 0,
      glassCollected: 0,
      copperCollected: 0,
      obsidianCollected: 0,
      starShardCollected: 0,
    };

    if (mode === 'cozy') {
      this.toolTier = 4;
      this.infiniteMask.fill(1);
    } else {
      // Alchemist Mode 初期スターターストック（初日の囲いと種まき用）
      this.stock[Mat.Water] = 24;
      this.stock[Mat.Soil] = 30;
      this.stock[Mat.Sand] = 12;
      this.stock[Mat.Wood] = 20;
      this.stock[Mat.Seed] = 6;
      this.infiniteMask[Mat.Air] = 1;
    }

    this.saveDawnState();
  }

  /** 日の出時点のストック・ティア状態を保存（全滅からの朝リトライ用） */
  saveDawnState(): void {
    this.dawnSnap.valid = true;
    this.dawnSnap.toolTier = this.toolTier;
    this.dawnSnap.raidsEnabled = this.raidsEnabled;
    this.dawnSnap.stock.set(this.stock);
    this.dawnSnap.infiniteMask.set(this.infiniteMask);
    this.dawnSnap.stats = { ...this.stats };
  }

  /** 日の出時点のストック・ティア状態を復元 */
  restoreDawnState(): boolean {
    if (!this.dawnSnap.valid) return false;
    this.toolTier = this.dawnSnap.toolTier;
    this.raidsEnabled = this.dawnSnap.raidsEnabled;
    this.stock.set(this.dawnSnap.stock);
    this.infiniteMask.set(this.dawnSnap.infiniteMask);
    this.stats = { ...this.dawnSnap.stats };
    return true;
  }

  /** 指定マテリアルの解放に必要なツールティアを取得 (0=解放対象外/二次生成物) */
  getRequiredTierForBrush(mat: MatId): ToolTier | 0 {
    if (mat === Mat.Air) return 1;
    for (const tier of [1, 2, 3, 4] as const) {
      if (TIER_BRUSH_GROUPS[tier].includes(mat)) return tier;
    }
    return 0;
  }

  /** 指定マテリアルが現在のモード・ツールティアで配置アンロック済みか判定 */
  isBrushUnlocked(mat: MatId): boolean {
    if (this.mode === 'cozy') return true;
    if (mat === Mat.Air) return true;
    if (MATERIALS[mat].secondaryProduct) return false;
    const req = this.getRequiredTierForBrush(mat);
    return req > 0 && this.toolTier >= req;
  }

  /** 現在解放済みのブラシ一覧を返す */
  getAvailableBrushes(): MatId[] {
    if (this.mode === 'cozy') {
      return [...ALL_PLAYABLE_BRUSHES];
    }
    return ALCHEMIST_PALETTE_BRUSHES.filter((m) => this.isBrushUnlocked(m));
  }

  /** パレットUI表示用：現在解放済み＋次ティアの予告ブラシ一覧を返す */
  getPaletteDisplayBrushes(): { mat: MatId; unlocked: boolean; requiredTier: ToolTier }[] {
    if (this.mode === 'cozy') {
      return ALL_PLAYABLE_BRUSHES.map((mat) => ({ mat, unlocked: true, requiredTier: 1 }));
    }
    const maxPreviewTier = Math.min(4, this.toolTier + 1) as ToolTier;
    const list: { mat: MatId; unlocked: boolean; requiredTier: ToolTier }[] = [];
    for (const mat of ALCHEMIST_PALETTE_BRUSHES) {
      const req = (this.getRequiredTierForBrush(mat) || 1) as ToolTier;
      if (req <= maxPreviewTier) {
        list.push({
          mat,
          unlocked: this.toolTier >= req,
          requiredTier: req,
        });
      }
    }
    return list;
  }

  /**
   * 吸引・掘削操作が可能か O(1) で判定する
   */
  canDigCell(mat: MatId, cellFlags: number): { ok: boolean; requiredTier: ToolTier | 99 } {
    if ((cellFlags & FLAG_INDESTRUCTIBLE) !== 0) {
      return { ok: false, requiredTier: 99 };
    }
    if (this.mode === 'cozy') {
      return { ok: true, requiredTier: 1 };
    }
    // 古代遺構ブロックは Tier 3（電工・配管）で回収・移設可能になる
    if ((cellFlags & FLAG_RUIN) !== 0 && this.toolTier < 3) {
      return { ok: false, requiredTier: 3 };
    }
    const hardness = MAT_HARDNESS[mat] as 0 | 1 | 2 | 3;
    if (hardness > this.toolTier) {
      return { ok: false, requiredTier: hardness as ToolTier };
    }
    return { ok: true, requiredTier: (hardness || 1) as ToolTier };
  }

  /**
   * 掘削・吸引したセルを対応するクラフト・配置ストックへ変換加算する
   */
  harvestCell(mat: MatId, currentDay: number = 1): void {
    if (this.mode === 'cozy' || mat === Mat.Air) return;

    switch (mat) {
      case Mat.Soil:
      case Mat.WetSoil:
      case Mat.BlightSoil:
      case Mat.Ash:
        this.stock[Mat.Soil]++;
        break;
      case Mat.Water:
        this.stock[Mat.Water]++;
        break;
      case Mat.BlightWater:
      case Mat.Miasma:
      case Mat.Smoke:
      case Mat.Steam:
      case Mat.Spore:
        // 汚染水や気体は除去のみ（浄化してから吸うと清水ストックになる）
        break;
      case Mat.PlantStem:
      case Mat.Leaf:
      case Mat.Flower:
        this.stock[Mat.Wood]++;
        this.floraHarvestCounter++;
        if (this.floraHarvestCounter % 3 === 0) {
          this.stock[Mat.Seed]++;
        }
        break;
      case Mat.Fruit:
        this.stock[Mat.Seed]++;
        this.stats.bioDelivered++;
        break;
      case Mat.HardStone:
        this.stock[Mat.Stone]++;
        break;
      case Mat.GateOpen:
        this.stock[Mat.GateClosed]++;
        break;
      case Mat.Glass:
        this.stock[Mat.Glass]++;
        this.stats.glassCollected++;
        break;
      case Mat.Copper:
        this.stock[Mat.Copper]++;
        this.stats.copperCollected++;
        break;
      case Mat.Obsidian:
        this.stock[Mat.Stone] += 2;
        this.stats.obsidianCollected++;
        break;
      case Mat.StarShard:
        this.stock[Mat.Copper] += 2;
        this.stats.starShardCollected++;
        break;
      default:
        if (mat < MAT_COUNT) {
          this.stock[mat]++;
        }
        break;
    }

    this.checkTierPromotion(currentDay);
  }

  /**
   * 指定マテリアルの現在利用可能な実質ストック数（フィールドクラフト代替含む）を取得
   */
  getEffectiveStock(mat: MatId): { infinite: boolean; count: number } {
    if (this.mode === 'cozy' || mat === Mat.Air || this.infiniteMask[mat] === 1) {
      return { infinite: true, count: 9999 };
    }
    // 着火 (Fire) は Tier 1〜2 では木材ストックを 1 消費して焚き火を起こす
    if (mat === Mat.Fire) {
      if (this.toolTier >= 3) return { infinite: true, count: 9999 };
      return {
        infinite: this.infiniteMask[Mat.Wood] === 1,
        count: this.stock[Mat.Fire] + this.stock[Mat.Wood],
      };
    }
    // 配管パイプは専用ストックのほか石材・銅から直接フィールド敷設可能
    if (mat === Mat.Pipe) {
      return {
        infinite: false,
        count: this.stock[Mat.Pipe] + this.stock[Mat.Stone] + this.stock[Mat.Copper],
      };
    }
    // 電機・制御素子は専用ストックのほか銅ストック 1 で直接フィールドクラフト可能（法則A：最小操作の維持）
    if (
      mat === Mat.RotorHub ||
      mat === Mat.Pump ||
      mat === Mat.Battery ||
      mat === Mat.GateClosed ||
      mat === Mat.Sensor
    ) {
      return {
        infinite: false,
        count: this.stock[mat] + this.stock[Mat.Copper],
      };
    }

    return { infinite: false, count: this.stock[mat] };
  }

  /**
   * 1セル配置分のストックを消費する（不足時は false）
   */
  consumeForPlace(mat: MatId): boolean {
    if (!this.isBrushUnlocked(mat)) return false;
    if (this.mode === 'cozy' || mat === Mat.Air || this.infiniteMask[mat] === 1) {
      return true;
    }

    if (mat === Mat.Fire) {
      if (this.toolTier >= 3 || this.infiniteMask[Mat.Wood] === 1) return true;
      if (this.stock[Mat.Fire] > 0) {
        this.stock[Mat.Fire]--;
        return true;
      }
      if (this.stock[Mat.Wood] > 0) {
        this.stock[Mat.Wood]--;
        return true;
      }
      return false;
    }

    if (this.stock[mat] > 0) {
      this.stock[mat]--;
      return true;
    }

    if (mat === Mat.Pipe) {
      if (this.stock[Mat.Stone] > 0) {
        this.stock[Mat.Stone]--;
        return true;
      }
      if (this.stock[Mat.Copper] > 0) {
        this.stock[Mat.Copper]--;
        return true;
      }
      return false;
    }

    if (
      mat === Mat.RotorHub ||
      mat === Mat.Pump ||
      mat === Mat.Battery ||
      mat === Mat.GateClosed ||
      mat === Mat.Sensor
    ) {
      if (this.stock[Mat.Copper] > 0) {
        this.stock[Mat.Copper]--;
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * テラリウム・コアへの納品を記録し、ティア昇格判定を行う
   */
  recordDelivery(kind: DeliveryKind, amount: number, currentDay: number = 1): void {
    this.onDeliver?.(kind, amount);
    if (this.mode !== 'alchemist') return;

    if (kind === 'water') {
      this.stats.waterDelivered += amount;
    } else if (kind === 'nectar' || kind === 'fruit') {
      this.stats.bioDelivered += amount;
    } else if (kind === 'power') {
      this.stats.powerDelivered += amount;
    } else if (kind === 'obsidian') {
      this.stats.obsidianCollected += amount;
    } else if (kind === 'star_shard') {
      this.stats.starShardCollected += amount;
    }

    this.checkTierPromotion(currentDay);
  }

  /**
   * 現地開拓・納品・生存日数の複合条件からツールティア昇格を判定する
   */
  checkTierPromotion(currentDay: number = 1): void {
    if (this.mode !== 'alchemist') return;

    while (this.toolTier < 4) {
      if (this.toolTier === 1) {
        const ready =
          currentDay >= 2 ||
          this.stats.waterDelivered + this.stats.bioDelivered >= 40 ||
          this.stats.glassCollected >= 4;
        if (!ready) break;
        this.promoteToTier(2);
      } else if (this.toolTier === 2) {
        const ready =
          (this.stats.copperCollected >= 6 &&
            (this.stats.waterDelivered + this.stats.bioDelivered >= 50 || currentDay >= 4)) ||
          this.stats.powerDelivered >= 40 ||
          this.stats.waterDelivered + this.stats.bioDelivered >= 120;
        if (!ready) break;
        this.promoteToTier(3);
      } else if (this.toolTier === 3) {
        const ready =
          this.stats.obsidianCollected >= 10 && this.stats.starShardCollected >= 6;
        if (!ready) break;
        this.promoteToTier(4);
      }
    }
  }

  private promoteToTier(nextTier: ToolTier): void {
    this.toolTier = nextTier;
    const unlocked = [...TIER_BRUSH_GROUPS[nextTier]];

    if (nextTier === 2) {
      this.stock[Mat.Stone] += 18;
      this.stock[Mat.Glass] += 10;
      this.stock[Mat.Mushroom] += 4;
    } else if (nextTier === 3) {
      this.infiniteMask[Mat.Fire] = 1;
      this.stock[Mat.Copper] += 20;
      this.stock[Mat.Pipe] += 20;
      this.stock[Mat.Pump] += 2;
      this.stock[Mat.RotorHub] += 2;
      this.stock[Mat.VoltFern] += 4;
      this.stock[Mat.Battery] += 2;
      this.stock[Mat.Sensor] += 2;
      this.stock[Mat.GateClosed] += 6;
    } else if (nextTier === 4) {
      // 第4段階（マスター・トイ期）：全解放ブラシのストック制約を解除して自由な巨大建築へ委譲（法則B）
      this.stock[Mat.WeatherAntenna] += 2;
      for (const m of ALCHEMIST_PALETTE_BRUSHES) {
        this.infiniteMask[m] = 1;
      }
    }

    this.onTierUnlocked?.(nextTier, unlocked);
  }

  /**
   * 1秒ごとにワールド内の稼働インフラ（開通湧水石・大森林・発電網）を検査し、実質無限化 (INF) を付与する
   */
  evaluateInfrastructure(world: WorldGrid): void {
    if (this.mode !== 'alchemist') return;

    this.checkTierPromotion(world.dayCount);

    let activeSpringOpen = false;
    let floraCells = 0;
    let activeChargeCells = 0;

    const types = world.type;
    const metas = world.meta;
    const charges = world.charge;

    for (let i = 0; i < types.length; i++) {
      const m = types[i];
      if (m === Mat.Spring && metas[i] === 0) {
        activeSpringOpen = true;
      } else if (m === Mat.PlantStem || m === Mat.Leaf || m === Mat.Flower) {
        floraCells++;
      }
      if (charges[i] >= 50) {
        activeChargeCells++;
      }
    }

    if (activeSpringOpen && this.infiniteMask[Mat.Water] === 0) {
      this.infiniteMask[Mat.Water] = 1;
      this.onInfiniteUnlocked?.(Mat.Water);
    }
    if (floraCells >= 45 && this.infiniteMask[Mat.Wood] === 0) {
      this.infiniteMask[Mat.Wood] = 1;
      this.infiniteMask[Mat.Seed] = 1;
      this.onInfiniteUnlocked?.(Mat.Wood);
    }
    if (activeChargeCells >= 12 && this.infiniteMask[Mat.Fire] === 0) {
      this.infiniteMask[Mat.Fire] = 1;
    }
  }

  /**
   * サイドバー目標パネルに表示する現在ティアの進行ビューを構築する
   */
  getCurrentMilestoneView(currentDay: number = 1): TierMilestoneView | null {
    if (this.mode !== 'alchemist' || this.toolTier >= 4) {
      return null;
    }

    if (this.toolTier === 1) {
      return {
        tier: 1,
        titleKey: 'tier_1_title',
        descKey: 'tier_1_desc',
        lawKey: 'tier_1_law',
        bars: [
          {
            labelKey: 'req_oasis_care',
            current: Math.min(40, this.stats.waterDelivered + this.stats.bioDelivered),
            target: 40,
          },
          {
            labelKey: 'req_survive_dawn',
            current: currentDay >= 2 ? 1 : 0,
            target: 1,
          },
        ],
        nextUnlockMats: [...TIER_BRUSH_GROUPS[2]],
      };
    }

    if (this.toolTier === 2) {
      return {
        tier: 2,
        titleKey: 'tier_2_title',
        descKey: 'tier_2_desc',
        lawKey: 'tier_2_law',
        bars: [
          {
            labelKey: 'req_copper_ore',
            current: Math.min(6, this.stats.copperCollected),
            target: 6,
          },
          {
            labelKey: 'req_oasis_care',
            current: Math.min(50, this.stats.waterDelivered + this.stats.bioDelivered),
            target: 50,
          },
        ],
        nextUnlockMats: [...TIER_BRUSH_GROUPS[3]],
      };
    }

    return {
      tier: 3,
      titleKey: 'tier_3_title',
      descKey: 'tier_3_desc',
      lawKey: 'tier_3_law',
      bars: [
        {
          labelKey: 'req_obsidian',
          current: Math.min(10, this.stats.obsidianCollected),
          target: 10,
        },
        {
          labelKey: 'req_star_shard',
          current: Math.min(6, this.stats.starShardCollected),
          target: 6,
        },
      ],
      nextUnlockMats: [...TIER_BRUSH_GROUPS[4]],
    };
  }
}
