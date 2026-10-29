import { MATERIALS, Mat, MatId } from '../core/materials';
import { GameMode } from '../core/terrainGen';

export type DeliveryKind = 'water' | 'nectar' | 'fruit' | 'power' | 'obsidian' | 'star_shard';

export interface StageRequirement {
  kind: 'water' | 'nectar_or_fruit' | 'power' | 'obsidian' | 'star_shard';
  target: number;
}

export interface AlchemistStageDef {
  stage: number; // 1 ~ 5
  titleKey: string;
  descKey: string;
  requirements: StageRequirement[];
  unlockedBrushes: MatId[];
}

/** Alchemist Mode 初期状態から使える基本ブラシ */
export const INITIAL_ALCHEMIST_BRUSHES: readonly MatId[] = [
  Mat.Air,
  Mat.Water,
  Mat.Sand,
  Mat.Soil,
  Mat.Stone,
  Mat.Fire,
  Mat.Mushroom,
];

/** Alchemist Mode 全5段階のプログレッション・ラダー定義 */
export const ALCHEMIST_STAGES: readonly AlchemistStageDef[] = [
  {
    stage: 1,
    titleKey: 'stage_1_title',
    descKey: 'stage_1_desc',
    requirements: [{ kind: 'water', target: 100 }],
    unlockedBrushes: [Mat.Seed, Mat.Wood, Mat.Glass],
  },
  {
    stage: 2,
    titleKey: 'stage_2_title',
    descKey: 'stage_2_desc',
    requirements: [{ kind: 'nectar_or_fruit', target: 40 }],
    unlockedBrushes: [Mat.Copper, Mat.VoltFern, Mat.RotorHub],
  },
  {
    stage: 3,
    titleKey: 'stage_3_title',
    descKey: 'stage_3_desc',
    requirements: [{ kind: 'power', target: 400 }],
    unlockedBrushes: [Mat.Magma, Mat.Pipe, Mat.Pump, Mat.Battery],
  },
  {
    stage: 4,
    titleKey: 'stage_4_title',
    descKey: 'stage_4_desc',
    requirements: [
      { kind: 'obsidian', target: 15 },
      { kind: 'power', target: 250 },
    ],
    unlockedBrushes: [Mat.GateClosed, Mat.Sensor, Mat.Lightning],
  },
  {
    stage: 5,
    titleKey: 'stage_5_title',
    descKey: 'stage_5_desc',
    requirements: [{ kind: 'star_shard', target: 8 }],
    unlockedBrushes: [Mat.WeatherAntenna],
  },
];

/** Cozy Toy Mode でパレットに表示する全ブラシ一覧 */
export const ALL_PLAYABLE_BRUSHES: readonly MatId[] = [
  Mat.Air,
  Mat.Water,
  Mat.Sand,
  Mat.Soil,
  Mat.Stone,
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
  Mat.Nectar,
  Mat.Obsidian,
  Mat.StarShard,
];

/**
 * ゲームモードと Alchemist 納品・アンロック進行を管理するクラス (Phase 4)
 */
export class ProgressionManager {
  mode: GameMode = 'cozy';
  stage: number = 1; // 1~5, 6=全ステージ達成完了
  progress: Record<StageRequirement['kind'], number> = {
    water: 0,
    nectar_or_fruit: 0,
    power: 0,
    obsidian: 0,
    star_shard: 0,
  };

  onDeliver?: (kind: DeliveryKind, amount: number) => void;
  onStageUnlocked?: (completedStage: number, newlyUnlocked: MatId[]) => void;

  reset(mode: GameMode): void {
    this.mode = mode;
    this.stage = 1;
    this.resetProgressCounters();
  }

  private resetProgressCounters(): void {
    this.progress = {
      water: 0,
      nectar_or_fruit: 0,
      power: 0,
      obsidian: 0,
      star_shard: 0,
    };
  }

  /** 指定マテリアルが現在のモード・進行状況でブラシ配置可能か判定 */
  isBrushUnlocked(mat: MatId): boolean {
    if (this.mode === 'cozy') return true;

    // Alchemist Mode では二次生成物は直接ブラシ配置不可
    if (MATERIALS[mat].secondaryProduct) return false;

    if (INITIAL_ALCHEMIST_BRUSHES.includes(mat)) return true;

    for (let s = 0; s < ALCHEMIST_STAGES.length; s++) {
      const st = ALCHEMIST_STAGES[s];
      if (this.stage > st.stage && st.unlockedBrushes.includes(mat)) {
        return true;
      }
    }
    return false;
  }

  /** 現在表示可能なブラシ一覧を返す */
  getAvailableBrushes(): MatId[] {
    if (this.mode === 'cozy') {
      return [...ALL_PLAYABLE_BRUSHES];
    }
    return ALL_PLAYABLE_BRUSHES.filter((m) => this.isBrushUnlocked(m));
  }

  /** 現在進行中のステージ定義を取得（全達成時は null） */
  getCurrentStageDef(): AlchemistStageDef | null {
    if (this.mode !== 'alchemist' || this.stage > ALCHEMIST_STAGES.length) {
      return null;
    }
    return ALCHEMIST_STAGES[this.stage - 1];
  }

  /** テラリウム・コアへの納品を処理し、ステージクリア判定を行う */
  recordDelivery(kind: DeliveryKind, amount: number): void {
    this.onDeliver?.(kind, amount);
    if (this.mode !== 'alchemist') return;

    const currentDef = this.getCurrentStageDef();
    if (!currentDef) return;

    const mappedKind: StageRequirement['kind'] =
      kind === 'nectar' || kind === 'fruit' ? 'nectar_or_fruit' : kind;

    for (const req of currentDef.requirements) {
      if (req.kind === mappedKind) {
        this.progress[mappedKind] = Math.min(req.target, this.progress[mappedKind] + amount);
      }
    }

    // すべての要件を満たしたかチェック
    const allMet = currentDef.requirements.every(
      (req) => this.progress[req.kind] >= req.target
    );

    if (allMet) {
      const completed = this.stage;
      const unlocked = [...currentDef.unlockedBrushes];
      this.stage++;
      this.resetProgressCounters();
      this.onStageUnlocked?.(completed, unlocked);
    }
  }
}

