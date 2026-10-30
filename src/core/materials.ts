/**
 * マテリアルID・物理属性・硬度・カラーパレット定義
 * Canvas ImageData (Little Endian Uint32Array) 向けに 0xAABBGGRR 形式の色を事前計算する
 */

/** 前景マテリアルID */
export const Mat = {
  Air: 0,
  Stone: 1,
  Sand: 2,
  Soil: 3,
  WetSoil: 4,
  Water: 5,
  Magma: 6,
  Nectar: 7,
  Steam: 8,
  Spore: 9,
  Fire: 10,
  Smoke: 11,
  Ash: 12,
  Seed: 13,
  PlantStem: 14,
  Leaf: 15,
  Flower: 16,
  Fruit: 17,
  Mushroom: 18,
  VoltFern: 19,
  Wood: 20,
  Glass: 21,
  Obsidian: 22,
  StarShard: 23,
  Lightning: 24,
  Copper: 25,
  RotorHub: 26,
  Battery: 27,
  Pipe: 28,
  Pump: 29,
  GateClosed: 30,
  GateOpen: 31,
  Sensor: 32,
  WeatherAntenna: 33,
  Core: 34,
  Spring: 35,
  HardStone: 36,
  BlightWater: 37,
  BlightSoil: 38,
  Miasma: 39,
} as const;

export type MatId = (typeof Mat)[keyof typeof Mat];
export const MAT_COUNT = 40;

/** 背景構造レイヤーID */
export const BgMat = {
  None: 0,
  WoodPillar: 1,
  WoodArch: 2,
  StoneWall: 3,
  RotorBlade: 4,
  CoreTree: 5,
} as const;

export type BgMatId = (typeof BgMat)[keyof typeof BgMat];

/** マテリアルの物理挙動カテゴリ */
export const MatCategory = {
  Empty: 0,
  Solid: 1,    // 固定固体
  Powder: 2,   // 重力落下する粉体・粒体
  Liquid: 3,   // 流体
  Gas: 4,      // 上昇・拡散する気体
  Flora: 5,    // 植物
  Energy: 6,   // 火・雷などのエネルギー体
  Machine: 7,  // 回路・機械素子
} as const;

export type MatCategoryId = (typeof MatCategory)[keyof typeof MatCategory];

/** RGBA (0-255) を Little-Endian ABGR 32bit 整数にパックする */
export function packABGR(r: number, g: number, b: number, a: number = 255): number {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

/** マテリアル静的プロパティ定義インターフェース */
export interface MaterialDef {
  id: MatId;
  key: string;
  category: MatCategoryId;
  hardness: 0 | 1 | 2 | 3;  // 必要ツールティア (0:気体/エネルギー, 1:素手/木工, 2:石工, 3:星屑制御)
  density: number;          // 密度（大きいほど下に沈む）
  defaultTemp: number;      // 初期温度 (℃)
  heatConductivity: number; // 熱伝導率 (0.0 ~ 1.0)
  flammability: number;     // 燃焼しやすさ (0 ~ 100)
  conductive: boolean;      // 電気を通すか
  insulator: boolean;       // 断熱材か（ガラス等）
  dispersion: number;       // 液体・気体の横拡散ステップ数
  baseColors: [number, number, number]; // 3段階のテクスチャバリエーション色 (ABGR)
  glowColor?: [number, number, number]; // 発光RGB強度 (0~255)
  secondaryProduct?: boolean;           // Alchemist Mode で直接ブラシ配置不可の創発・地形専用要素か
}

function makePalette(
  r: number,
  g: number,
  b: number,
  delta: number = 10,
  alpha: number = 255
): [number, number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(255, v | 0));
  return [
    packABGR(clamp(r - delta), clamp(g - delta), clamp(b - delta), alpha),
    packABGR(clamp(r), clamp(g), clamp(b), alpha),
    packABGR(clamp(r + delta), clamp(g + delta), clamp(b + delta), alpha),
  ];
}

/** 全マテリアルの属性テーブル（インデックス = MatId） */
export const MATERIALS: readonly MaterialDef[] = [
  // 0: Air
  {
    id: Mat.Air,
    key: 'air',
    category: MatCategory.Empty,
    hardness: 0,
    density: 0,
    defaultTemp: 22,
    heatConductivity: 0.15,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: [0, 0, 0],
  },
  // 1: Stone
  {
    id: Mat.Stone,
    key: 'stone',
    category: MatCategory.Solid,
    hardness: 2,
    density: 100,
    defaultTemp: 20,
    heatConductivity: 0.35,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(104, 110, 122, 9),
  },
  // 2: Sand
  {
    id: Mat.Sand,
    key: 'sand',
    category: MatCategory.Powder,
    hardness: 1,
    density: 65,
    defaultTemp: 24,
    heatConductivity: 0.3,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(228, 198, 132, 12),
  },
  // 3: Soil
  {
    id: Mat.Soil,
    key: 'soil',
    category: MatCategory.Powder,
    hardness: 1,
    density: 60,
    defaultTemp: 22,
    heatConductivity: 0.25,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(134, 94, 62, 10),
  },
  // 4: WetSoil
  {
    id: Mat.WetSoil,
    key: 'wet_soil',
    category: MatCategory.Powder,
    hardness: 1,
    density: 68,
    defaultTemp: 20,
    heatConductivity: 0.4,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(86, 58, 40, 8),
    secondaryProduct: true,
  },
  // 5: Water
  {
    id: Mat.Water,
    key: 'water',
    category: MatCategory.Liquid,
    hardness: 1,
    density: 30,
    defaultTemp: 20,
    heatConductivity: 0.6,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 5,
    baseColors: makePalette(64, 156, 235, 10),
  },
  // 6: Magma
  {
    id: Mat.Magma,
    key: 'magma',
    category: MatCategory.Liquid,
    hardness: 3,
    density: 80,
    defaultTemp: 850,
    heatConductivity: 0.85,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 2,
    baseColors: makePalette(255, 102, 28, 22),
    glowColor: [255, 110, 30],
  },
  // 7: Nectar
  {
    id: Mat.Nectar,
    key: 'nectar',
    category: MatCategory.Liquid,
    hardness: 1,
    density: 36,
    defaultTemp: 22,
    heatConductivity: 0.3,
    flammability: 75,
    conductive: false,
    insulator: false,
    dispersion: 2,
    baseColors: makePalette(248, 190, 52, 12),
    glowColor: [90, 65, 15],
    secondaryProduct: true,
  },
  // 8: Steam
  {
    id: Mat.Steam,
    key: 'steam',
    category: MatCategory.Gas,
    hardness: 0,
    density: -15,
    defaultTemp: 115,
    heatConductivity: 0.45,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 4,
    baseColors: makePalette(215, 232, 245, 12),
    secondaryProduct: true,
  },
  // 9: Spore
  {
    id: Mat.Spore,
    key: 'spore',
    category: MatCategory.Gas,
    hardness: 0,
    density: -5,
    defaultTemp: 22,
    heatConductivity: 0.15,
    flammability: 85,
    conductive: false,
    insulator: false,
    dispersion: 3,
    baseColors: makePalette(126, 240, 212, 16),
    glowColor: [60, 180, 155],
    secondaryProduct: true,
  },
  // 10: Fire
  {
    id: Mat.Fire,
    key: 'fire',
    category: MatCategory.Energy,
    hardness: 0,
    density: -20,
    defaultTemp: 520,
    heatConductivity: 0.9,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 2,
    baseColors: [
      packABGR(255, 90, 24),
      packABGR(255, 168, 36),
      packABGR(255, 230, 96),
    ],
    glowColor: [255, 145, 45],
  },
  // 11: Smoke
  {
    id: Mat.Smoke,
    key: 'smoke',
    category: MatCategory.Gas,
    hardness: 0,
    density: -18,
    defaultTemp: 90,
    heatConductivity: 0.2,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 3,
    baseColors: makePalette(88, 86, 94, 10),
    secondaryProduct: true,
  },
  // 12: Ash
  {
    id: Mat.Ash,
    key: 'ash',
    category: MatCategory.Powder,
    hardness: 1,
    density: 45,
    defaultTemp: 40,
    heatConductivity: 0.2,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(156, 152, 148, 10),
    secondaryProduct: true,
  },
  // 13: Seed
  {
    id: Mat.Seed,
    key: 'seed',
    category: MatCategory.Powder,
    hardness: 1,
    density: 50,
    defaultTemp: 22,
    heatConductivity: 0.2,
    flammability: 50,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(148, 198, 72, 10),
  },
  // 14: PlantStem
  {
    id: Mat.PlantStem,
    key: 'plant_stem',
    category: MatCategory.Flora,
    hardness: 1,
    density: 90,
    defaultTemp: 22,
    heatConductivity: 0.25,
    flammability: 45,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(68, 148, 66, 10),
    secondaryProduct: true,
  },
  // 15: Leaf
  {
    id: Mat.Leaf,
    key: 'leaf',
    category: MatCategory.Flora,
    hardness: 1,
    density: 85,
    defaultTemp: 22,
    heatConductivity: 0.2,
    flammability: 65,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(96, 188, 78, 14),
    secondaryProduct: true,
  },
  // 16: Flower
  {
    id: Mat.Flower,
    key: 'flower',
    category: MatCategory.Flora,
    hardness: 1,
    density: 85,
    defaultTemp: 22,
    heatConductivity: 0.2,
    flammability: 60,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: [
      packABGR(246, 118, 162),
      packABGR(255, 166, 196),
      packABGR(252, 212, 108),
    ],
    glowColor: [70, 40, 55],
    secondaryProduct: true,
  },
  // 17: Fruit
  {
    id: Mat.Fruit,
    key: 'fruit',
    category: MatCategory.Powder,
    hardness: 1,
    density: 52,
    defaultTemp: 22,
    heatConductivity: 0.25,
    flammability: 40,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(238, 82, 92, 12),
    glowColor: [80, 25, 30],
    secondaryProduct: true,
  },
  // 18: Mushroom (発光キノコ)
  {
    id: Mat.Mushroom,
    key: 'mushroom',
    category: MatCategory.Flora,
    hardness: 1,
    density: 85,
    defaultTemp: 20,
    heatConductivity: 0.25,
    flammability: 35,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: [
      packABGR(56, 216, 206),
      packABGR(88, 242, 224),
      packABGR(142, 255, 242),
    ],
    glowColor: [65, 230, 215],
  },
  // 19: VoltFern (発電シダ)
  {
    id: Mat.VoltFern,
    key: 'volt_fern',
    category: MatCategory.Flora,
    hardness: 1,
    density: 90,
    defaultTemp: 22,
    heatConductivity: 0.35,
    flammability: 20,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(124, 224, 112, 14),
    glowColor: [80, 195, 95],
  },
  // 20: Wood
  {
    id: Mat.Wood,
    key: 'wood',
    category: MatCategory.Solid,
    hardness: 1,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.2,
    flammability: 35,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(152, 102, 62, 10),
  },
  // 21: Glass
  {
    id: Mat.Glass,
    key: 'glass',
    category: MatCategory.Solid,
    hardness: 2,
    density: 100,
    defaultTemp: 20,
    heatConductivity: 0.02, // 高い断熱性
    flammability: 0,
    conductive: false,
    insulator: true,
    dispersion: 0,
    baseColors: makePalette(186, 228, 242, 8),
  },
  // 22: Obsidian
  {
    id: Mat.Obsidian,
    key: 'obsidian',
    category: MatCategory.Powder,
    hardness: 3,
    density: 92,
    defaultTemp: 60,
    heatConductivity: 0.2,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: [
      packABGR(42, 30, 62),
      packABGR(58, 42, 86),
      packABGR(82, 58, 118),
    ],
    glowColor: [45, 25, 75],
    secondaryProduct: true,
  },
  // 23: StarShard (星のかけら)
  {
    id: Mat.StarShard,
    key: 'star_shard',
    category: MatCategory.Powder,
    hardness: 3,
    density: 88,
    defaultTemp: 45,
    heatConductivity: 0.4,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: [
      packABGR(255, 226, 120),
      packABGR(255, 245, 178),
      packABGR(198, 232, 255),
    ],
    glowColor: [255, 235, 150],
    secondaryProduct: true,
  },
  // 24: Lightning
  {
    id: Mat.Lightning,
    key: 'lightning',
    category: MatCategory.Energy,
    hardness: 0,
    density: -10,
    defaultTemp: 650,
    heatConductivity: 0.9,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: [
      packABGR(210, 238, 255),
      packABGR(255, 255, 210),
      packABGR(160, 215, 255),
    ],
    glowColor: [210, 240, 255],
  },
  // 25: Copper
  {
    id: Mat.Copper,
    key: 'copper',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.75,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(214, 124, 72, 10),
  },
  // 26: RotorHub (羽根車の軸)
  {
    id: Mat.RotorHub,
    key: 'rotor_hub',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.5,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(232, 172, 84, 8),
    glowColor: [90, 70, 30],
  },
  // 27: Battery
  {
    id: Mat.Battery,
    key: 'battery',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.4,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(76, 168, 154, 10),
  },
  // 28: Pipe
  {
    id: Mat.Pipe,
    key: 'pipe',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.35,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(118, 146, 162, 8),
  },
  // 29: Pump
  {
    id: Mat.Pump,
    key: 'pump',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.4,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(68, 128, 196, 10),
  },
  // 30: GateClosed
  {
    id: Mat.GateClosed,
    key: 'gate',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.3,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(142, 96, 168, 8),
  },
  // 31: GateOpen
  {
    id: Mat.GateOpen,
    key: 'gate_open',
    category: MatCategory.Empty,
    hardness: 2,
    density: 0,
    defaultTemp: 22,
    heatConductivity: 0.2,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(92, 66, 114, 6),
    secondaryProduct: true,
  },
  // 32: Sensor
  {
    id: Mat.Sensor,
    key: 'sensor',
    category: MatCategory.Machine,
    hardness: 2,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.4,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(98, 186, 134, 8),
  },
  // 33: WeatherAntenna
  {
    id: Mat.WeatherAntenna,
    key: 'weather_antenna',
    category: MatCategory.Machine,
    hardness: 3,
    density: 100,
    defaultTemp: 22,
    heatConductivity: 0.6,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(198, 214, 245, 10),
    glowColor: [120, 175, 255],
  },
  // 34: Core (テラリウム・コア)
  {
    id: Mat.Core,
    key: 'core',
    category: MatCategory.Machine,
    hardness: 3,
    density: 255,
    defaultTemp: 24,
    heatConductivity: 0.5,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 0,
    baseColors: [
      packABGR(108, 236, 176),
      packABGR(146, 252, 204),
      packABGR(212, 255, 232),
    ],
    glowColor: [110, 245, 185],
    secondaryProduct: true,
  },
  // 35: Spring (天然水源石)
  {
    id: Mat.Spring,
    key: 'spring',
    category: MatCategory.Solid,
    hardness: 3,
    density: 200,
    defaultTemp: 16,
    heatConductivity: 0.5,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(76, 148, 188, 10),
    glowColor: [40, 110, 160],
    secondaryProduct: true,
  },
  // 36: HardStone (硬岩層: Tier 2 以上の掘削が必要)
  {
    id: Mat.HardStone,
    key: 'hard_stone',
    category: MatCategory.Solid,
    hardness: 2,
    density: 120,
    defaultTemp: 18,
    heatConductivity: 0.3,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(68, 76, 92, 8),
    secondaryProduct: true,
  },
  // 37: BlightWater (汚染水: 発光キノコ・灰・砂濾過で浄化)
  {
    id: Mat.BlightWater,
    key: 'blight_water',
    category: MatCategory.Liquid,
    hardness: 1,
    density: 32,
    defaultTemp: 19,
    heatConductivity: 0.5,
    flammability: 0,
    conductive: true,
    insulator: false,
    dispersion: 4,
    baseColors: makePalette(112, 86, 142, 10),
    glowColor: [38, 24, 52],
    secondaryProduct: true,
  },
  // 38: BlightSoil (腐敗土: 灰または発光キノコで湿潤土へ再生)
  {
    id: Mat.BlightSoil,
    key: 'blight_soil',
    category: MatCategory.Powder,
    hardness: 1,
    density: 64,
    defaultTemp: 20,
    heatConductivity: 0.25,
    flammability: 0,
    conductive: false,
    insulator: false,
    dispersion: 0,
    baseColors: makePalette(82, 68, 86, 8),
    secondaryProduct: true,
  },
  // 39: Miasma (瘴気霧: 夜間に漂い、光や熱で霧散する)
  {
    id: Mat.Miasma,
    key: 'miasma',
    category: MatCategory.Gas,
    hardness: 0,
    density: -3,
    defaultTemp: 15,
    heatConductivity: 0.15,
    flammability: 40,
    conductive: false,
    insulator: false,
    dispersion: 3,
    baseColors: makePalette(76, 56, 98, 10),
    secondaryProduct: true,
  },
];

/** 高速参照用ルックアップTypedArray（ホットループ内でのオブジェクト参照削減） */
export const MAT_CATEGORY = new Uint8Array(MAT_COUNT);
export const MAT_HARDNESS = new Uint8Array(MAT_COUNT);
export const MAT_DENSITY = new Int16Array(MAT_COUNT);
export const MAT_DEFAULT_TEMP = new Int16Array(MAT_COUNT);
export const MAT_FLAMMABILITY = new Uint8Array(MAT_COUNT);
export const MAT_CONDUCTIVE = new Uint8Array(MAT_COUNT);
export const MAT_INSULATOR = new Uint8Array(MAT_COUNT);
export const MAT_DISPERSION = new Uint8Array(MAT_COUNT);

for (let i = 0; i < MAT_COUNT; i++) {
  const def = MATERIALS[i];
  MAT_CATEGORY[i] = def.category;
  MAT_HARDNESS[i] = def.hardness;
  MAT_DENSITY[i] = def.density;
  MAT_DEFAULT_TEMP[i] = def.defaultTemp;
  MAT_FLAMMABILITY[i] = def.flammability;
  MAT_CONDUCTIVE[i] = def.conductive ? 1 : 0;
  MAT_INSULATOR[i] = def.insulator ? 1 : 0;
  MAT_DISPERSION[i] = def.dispersion;
}

/** 固定固体または機械（重力移動せず流体をブロックするもの）かどうか判定 */
export function isSolidBlocking(mat: number): boolean {
  const cat = MAT_CATEGORY[mat];
  return cat === MatCategory.Solid || cat === MatCategory.Machine || cat === MatCategory.Flora;
}
