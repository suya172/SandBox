import { BgMat, Mat } from './materials';
import { PRNG } from './prng';
import {
  FLAG_INDESTRUCTIBLE,
  FLAG_NO_BRUSH,
  FLAG_RUIN,
  HEIGHT,
  WIDTH,
  WorldGrid,
} from './world';

export type GameMode = 'cozy' | 'alchemist';

/**
 * シード値から初期テラリウム地形を決定論的に生成する
 * - Cozy Mode: 穏やかな湖畔と発光洞窟の箱庭
 * - Alchemist Mode: SPEC 3.2 準拠の 5ゾーン凝縮バイオーム＋古代遺構＋地下硬岩ロック構造
 */
export function generateTerrain(world: WorldGrid, mode: GameMode, customSeed?: number): void {
  const seed = customSeed !== undefined ? customSeed >>> 0 : world.seed;
  world.seed = seed;
  world.clear();
  world.rng = new PRNG(seed);
  const rng = new PRNG(seed ^ 0x9e3779b9);

  if (mode === 'cozy') {
    generateCozyTerrain(world, rng);
  } else {
    generateAlchemistFiveBiomes(world, rng);
  }

  world.updateLightField();
  world.wakeAll();
}

/**
 * Cozy Toy Mode 用の穏やかな湖畔・森林・発光洞窟生成
 */
function generateCozyTerrain(world: WorldGrid, rng: PRNG): void {
  const phase1 = rng.next() * Math.PI * 2;
  const phase2 = rng.next() * Math.PI * 2;
  const phase3 = rng.next() * Math.PI * 2;

  const surfaceY = new Int16Array(WIDTH);

  for (let x = 0; x < WIDTH; x++) {
    const nx = x / WIDTH;
    let h =
      88 +
      Math.sin(nx * Math.PI * 2.0 + phase1) * 10 +
      Math.sin(nx * Math.PI * 5.0 + phase2) * 5 +
      Math.sin(nx * Math.PI * 11.0 + phase3) * 2;

    const lakeDist = Math.abs(x - 68);
    if (lakeDist < 22) {
      h = 92 + Math.cos((lakeDist / 22) * (Math.PI / 2)) * 12;
    }
    surfaceY[x] = Math.max(40, Math.min(HEIGHT - 18, Math.round(h)));
  }

  for (let x = 0; x < WIDTH; x++) {
    const sy = surfaceY[x];
    const stoneDepth = sy + 9 + ((Math.sin(x * 0.17 + phase2) * 3) | 0);

    for (let y = sy; y < HEIGHT; y++) {
      if (y >= HEIGHT - 3) {
        world.setCell(x, y, Mat.Stone);
        world.flags[world.idx(x, y)] |= FLAG_INDESTRUCTIBLE;
        continue;
      }
      if (y >= stoneDepth) {
        world.setCell(x, y, Mat.Stone);
        world.setBg(x, y, BgMat.StoneWall);
      } else {
        const isBeach = Math.abs(x - 68) >= 18 && Math.abs(x - 68) <= 26 && y < sy + 4;
        if (isBeach) {
          world.setCell(x, y, Mat.Sand);
        } else if (y === sy && rng.chance(0.45)) {
          world.setCell(x, y, Mat.WetSoil, 120);
        } else {
          world.setCell(x, y, Mat.Soil);
        }
      }
    }
  }

  // 地下の発光キノコ洞窟
  carveGlowCavern(world, 168, 118, 26, 11, false);

  // 湖に水を満たし、天然湧水と草木・花を生やす
  for (let x = 47; x <= 89; x++) {
    for (let y = 93; y < surfaceY[x]; y++) {
      world.setCell(x, y, Mat.Water);
    }
    if (surfaceY[x] >= 92) {
      world.setCell(x, surfaceY[x], Mat.WetSoil, 180);
    }
  }
  world.setCell(52, 95, Mat.Spring, 0);

  for (const sx of [42, 95, 114, 142, 205]) {
    const sy = surfaceY[sx];
    world.setCell(sx, sy, Mat.WetSoil, 180);
    world.setCell(sx, sy - 1, Mat.Seed, 10);
  }
  world.setCell(45, surfaceY[45], Mat.WetSoil, 180);
  world.setCell(45, surfaceY[45] - 1, Mat.Mushroom, 15);
}

/**
 * Alchemist Mode 用の 5ゾーン凝縮バイオーム＆古代遺構生成 (SPEC 3.2)
 * ① 中央表層 (x: 96..160): 微睡みのオアシス（コア＋初期清水池＋若木）
 * ② 西表層   (x:  0..95) : 腐敗胞子の枯れ森（汚染水＋腐敗土＋枯れ木＋折れた木橋遺構）
 * ③ 東表層   (x:161..255): 灼熱砂丘と硝子遺跡（高温砂丘＋埋没パイプ/銅線遺構）
 * ④ 西〜中下層(y:104..140): 硬岩帯水層と発光洞窟（HardStone殻＋休眠湧水石＋銅鉱脈）
 * ⑤ 東最深層 (x:152..250): 黒曜地殻と灼熱マグマ層（Magma溜まり＋黒曜石殻）
 */
function generateAlchemistFiveBiomes(world: WorldGrid, rng: PRNG): void {
  const phase1 = rng.next() * Math.PI * 2;
  const phase2 = rng.next() * Math.PI * 2;
  const surfaceY = new Int16Array(WIDTH);

  // Day 1 の日の出直後から開始する
  world.timeOfDay = 0.26;
  world.dayCount = 1;

  // 1. ゾーン別の地表高度プロファイル設計
  for (let x = 0; x < WIDTH; x++) {
    let h = 84 + Math.sin((x / WIDTH) * Math.PI * 4 + phase1) * 4 + Math.sin(x * 0.22 + phase2) * 1.5;

    if (x < 96) {
      // ② 西：腐敗胞子の枯れ森（x=22..48 に汚染沼、x=56..74 に折れた橋の渓谷）
      if (x >= 20 && x <= 48) {
        const mireDist = Math.abs(x - 34) / 14;
        h = 89 - (1 - mireDist * mireDist) * (-5); // 中央 y≈94 の沼底
      } else if (x >= 56 && x <= 74) {
        const gapDist = Math.abs(x - 65) / 9;
        h = 93 - gapDist * 9; // 渓谷
      } else {
        h = 82 + Math.sin(x * 0.18 + phase1) * 2.5;
      }
    } else if (x <= 160) {
      // ① 中央：微睡みのオアシス（x=103..115 に初期清水くぼみ、x=128 にコア台座）
      if (x >= 101 && x <= 116) {
        const pondDist = Math.abs(x - 108.5) / 7.5;
        h = 86 + (1 - pondDist * pondDist) * 6; // 底 y≈92
      } else {
        const distCore = Math.abs(x - 128);
        if (distCore < 20) {
          const flat = 1 - distCore / 20;
          h = h * (1 - flat) + 86 * flat;
        }
      }
    } else {
      // ③ 東：灼熱砂丘と硝子遺跡（風紋を描く砂丘）
      const dune = Math.sin((x - 160) * 0.085 + phase1) * 6 + Math.cos((x - 160) * 0.04) * 3;
      h = 79 + dune;
    }

    surfaceY[x] = Math.max(46, Math.min(98, Math.round(h)));
  }

  // 2. 表層〜中層〜硬岩深層の充填
  for (let x = 0; x < WIDTH; x++) {
    const sy = surfaceY[x];
    const softDepth = x > 160 ? sy + 13 : sy + 8;
    const hardRockTop = 101 + ((Math.sin(x * 0.13 + phase2) * 3) | 0);

    for (let y = sy; y < HEIGHT; y++) {
      const i = world.idx(x, y);
      // 最下層ベッドロック
      if (y >= HEIGHT - 3) {
        world.setCell(x, y, Mat.HardStone);
        world.flags[i] |= FLAG_INDESTRUCTIBLE;
        continue;
      }

      // 硬度 H=2 の硬岩ロック層
      if (y >= hardRockTop) {
        world.setCell(x, y, Mat.HardStone);
        world.setBg(x, y, BgMat.StoneWall);
        continue;
      }

      // 中間の通常石材層
      if (y >= softDepth) {
        world.setCell(x, y, Mat.Stone);
        world.setBg(x, y, BgMat.StoneWall);
        continue;
      }

      // バイオーム別の表層堆積物
      if (x < 92) {
        world.setCell(x, y, y <= sy + 3 ? Mat.BlightSoil : Mat.Soil);
      } else if (x <= 160) {
        if (y === sy || (x >= 99 && x <= 118 && y <= sy + 2)) {
          world.setCell(x, y, Mat.WetSoil, 180);
        } else {
          world.setCell(x, y, Mat.Soil);
        }
      } else {
        world.setCell(x, y, Mat.Sand, 0, 30);
      }
    }
  }

  // 3. ④ 西〜中央地下：硬岩帯水層と発光洞窟＋休眠湧水石＋銅鉱脈
  carveGlowCavern(world, 76, 122, 38, 11, true);

  // 帯水層の奥に「硬岩1枚で封じられた休眠湧水石 (meta = 1)」を配置（開通すると無限水源化）
  const springX = 36;
  const springY = 124;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const gx = springX + dx;
      const gy = springY + dy;
      if (world.inBounds(gx, gy)) {
        world.setCell(gx, gy, Mat.HardStone);
        world.setBg(gx, gy, BgMat.StoneWall);
      }
    }
  }
  world.setCell(springX, springY, Mat.Spring, 1);
  world.flags[world.idx(springX, springY)] |= FLAG_INDESTRUCTIBLE;

  // 硬岩層内に銅鉱脈クラスターを配置（Tier 2 掘削で到達・採取可能）
  placeOreVein(world, 96, 108, 6, 3, Mat.Copper);
  placeOreVein(world, 126, 112, 7, 3, Mat.Copper);
  placeOreVein(world, 52, 107, 5, 2, Mat.Copper);

  // 4. ⑤ 東最深層：黒曜地殻と灼熱マグマ層
  const magCx = 202;
  const magCy = 126;
  for (let dy = -11; dy <= 11; dy++) {
    for (let dx = -34; dx <= 34; dx++) {
      const gx = magCx + dx;
      const gy = magCy + dy;
      if (!world.inBounds(gx, gy) || gy >= HEIGHT - 3) continue;
      const norm = (dx * dx) / (34 * 34) + (dy * dy) / (11 * 11);
      if (norm <= 0.78) {
        world.setBg(gx, gy, BgMat.StoneWall);
        if (gy >= 126) {
          world.setCell(gx, gy, Mat.Magma, 0, 850);
        } else {
          world.setCell(gx, gy, Mat.Air, 0, 220);
        }
      } else if (norm <= 0.96) {
        // マグマ溜まりの外殻に黒曜石と硬岩の混成クラストを形成
        const shellMat = ((gx + gy) & 3) === 0 ? Mat.Obsidian : Mat.HardStone;
        world.setCell(gx, gy, shellMat, 0, 140);
        world.setBg(gx, gy, BgMat.StoneWall);
      }
    }
  }

  // 5. ② 西表層の環境ディテール：汚染沼・枯れ木・野生の発光キノコ・折れた木橋遺構
  for (let x = 22; x <= 46; x++) {
    for (let y = 89; y < surfaceY[x]; y++) {
      world.setCell(x, y, Mat.BlightWater);
    }
  }
  // 初期木材資源となる枯れ木（伐採・吸引可能）
  for (const tx of [15, 51, 83]) {
    const sy = surfaceY[tx];
    for (let dy = 1; dy <= 6; dy++) {
      world.setCell(tx, sy - dy, Mat.Wood);
    }
    world.setCell(tx - 1, sy - 5, Mat.Wood);
    world.setCell(tx + 1, sy - 4, Mat.Wood);
  }
  // 西端の浄化ヒントとなる野生の発光キノコ株
  for (const mx of [9, 12]) {
    const sy = surfaceY[mx];
    world.setCell(mx, sy, Mat.WetSoil, 180);
    world.setCell(mx, sy - 1, Mat.Mushroom, 20);
  }
  // 折れた木造橋の遺構（中央数マスを木材で繋ぐだけで橋が完成する環境ストーリーテリング）
  const bridgeY = 83;
  for (const bx of [55, 56, 57, 58, 59, 60, 70, 71, 72, 73, 74]) {
    if (bridgeY < surfaceY[bx]) {
      world.setCell(bx, bridgeY, Mat.Wood, 2);
      world.flags[world.idx(bx, bridgeY)] |= FLAG_RUIN;
      if (bx === 57 || bx === 72) {
        for (let py = bridgeY + 1; py < surfaceY[bx]; py++) {
          world.setBg(bx, py, py === bridgeY + 1 ? BgMat.WoodArch : BgMat.WoodPillar);
        }
      }
    }
  }

  // 6. ③ 東表層の環境ディテール：砂に埋もれた古代硝子・パイプ・銅線遺構
  const ruinY = 83;
  for (let rx = 186; rx <= 202; rx++) {
    // 途中が2マス欠損した古代導水パイプ
    if (rx === 193 || rx === 194) continue;
    world.setCell(rx, ruinY, Mat.Pipe);
    world.flags[world.idx(rx, ruinY)] |= FLAG_RUIN;
  }
  for (let rx = 205; rx <= 216; rx++) {
    if (rx === 210) continue;
    world.setCell(rx, ruinY + 1, Mat.Copper);
    world.flags[world.idx(rx, ruinY + 1)] |= FLAG_RUIN;
  }
  // 砂丘から頭をのぞかせる古代ガラスドーム残骸
  for (const [gx, gy] of [
    [176, surfaceY[176] - 1],
    [177, surfaceY[177] - 2],
    [178, surfaceY[178] - 3],
    [182, surfaceY[182] - 2],
    [183, surfaceY[183] - 1],
  ]) {
    if (world.inBounds(gx, gy)) {
      world.setCell(gx, gy, Mat.Glass);
      world.flags[world.idx(gx, gy)] |= FLAG_RUIN;
    }
  }

  // 7. ① 中央オアシス：初期清水池・若木シード・テラリウム・コア配置
  for (let x = 102; x <= 115; x++) {
    for (let y = 87; y < surfaceY[x]; y++) {
      world.setCell(x, y, Mat.Water);
    }
    world.setCell(x, surfaceY[x], Mat.WetSoil, 200);
  }
  // オアシスの種と灯りキノコ
  for (const sx of [98, 146]) {
    const sy = surfaceY[sx];
    world.setCell(sx, sy, Mat.WetSoil, 200);
    world.setCell(sx, sy - 1, Mat.Seed, 10);
  }
  world.setCell(117, surfaceY[117], Mat.WetSoil, 200);
  world.setCell(117, surfaceY[117] - 1, Mat.Mushroom, 20);

  placeTerrariumCore(world, 128, surfaceY[128] - 2);
  world.coreVitality = world.maxCoreVitality;

  // 初日の朝スナップショットを保存
  world.saveDawnSnapshot();
}

function carveGlowCavern(
  world: WorldGrid,
  caveCenterX: number,
  caveCenterY: number,
  rx: number,
  ry: number,
  hardShell: boolean
): void {
  for (let dy = -ry - 2; dy <= ry + 2; dy++) {
    for (let dx = -rx - 2; dx <= rx + 2; dx++) {
      const gx = caveCenterX + dx;
      const gy = caveCenterY + dy;
      if (!world.inBounds(gx, gy) || gy >= HEIGHT - 3) continue;
      const norm = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
      if (norm < 0.85 + Math.sin(dx * 0.35) * 0.1) {
        world.setCell(gx, gy, Mat.Air);
        world.setBg(gx, gy, BgMat.StoneWall, 1);
        if (dy >= Math.floor(ry * 0.45)) {
          world.setCell(gx, gy, Mat.Water, 0, 17);
        }
      } else if (norm < 1.06 && dy > 2) {
        world.setCell(gx, gy, Mat.WetSoil, 170);
      } else if (hardShell && norm < 1.25 && gy >= 100) {
        world.setCell(gx, gy, Mat.HardStone);
        world.setBg(gx, gy, BgMat.StoneWall);
      }
    }
  }

  for (let dx = -rx + 4; dx <= rx - 4; dx += 6) {
    const gx = caveCenterX + dx;
    for (let gy = caveCenterY - 2; gy < HEIGHT - 4; gy++) {
      if (world.getMat(gx, gy) === Mat.Air && world.getMat(gx, gy + 1) === Mat.WetSoil) {
        world.setCell(gx, gy, Mat.Mushroom, 20);
        break;
      }
    }
  }
}

function placeOreVein(
  world: WorldGrid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  oreMat: typeof Mat.Copper
): void {
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      const norm = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
      if (norm <= 0.95) {
        world.setCell(gx, gy, oreMat);
        world.setBg(gx, gy, BgMat.StoneWall);
      }
    }
  }
}

/**
 * 中央の「古代の樹（テラリウム・コア）」と保護エリアを配置する
 */
export function placeTerrariumCore(world: WorldGrid, cx: number, cy: number): void {
  world.coreX = cx;
  world.coreY = cy;
  world.hasCore = true;
  world.coreVitality = world.maxCoreVitality;

  // 背景に古代樹の幹と枝葉を描画
  for (let dy = -16; dy <= 3; dy++) {
    for (let dx = -12; dx <= 12; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      const crownNorm = (dx * dx) / (12 * 12) + ((dy + 10) * (dy + 10)) / (7 * 7);
      const isTrunk = Math.abs(dx) <= 2 && dy >= -6 && dy <= 3;
      if (crownNorm <= 1.0 || isTrunk) {
        world.setBg(gx, gy, BgMat.CoreTree, crownNorm <= 1.0 && !isTrunk ? 2 : 1);
      }
    }
  }

  // 台座（石レンガ風）
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = 2; dy <= 4; dy++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (world.inBounds(gx, gy)) {
        world.setCell(gx, gy, Mat.Stone);
        world.flags[world.idx(gx, gy)] |= FLAG_INDESTRUCTIBLE;
      }
    }
  }

  // コア周囲をクリアしつつ直接ブラシ保護エリア (FLAG_NO_BRUSH) を設定
  for (let dy = -7; dy <= 3; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      const i = world.idx(gx, gy);
      world.flags[i] |= FLAG_NO_BRUSH;
      if (dy <= 1 && world.type[i] !== Mat.Stone) {
        world.setCell(gx, gy, Mat.Air);
      }
    }
  }

  // 3x3 のコア結晶本体
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      const i = world.idx(gx, gy);
      world.setCell(gx, gy, Mat.Core);
      world.flags[i] |= FLAG_INDESTRUCTIBLE | FLAG_NO_BRUSH;
    }
  }
}
