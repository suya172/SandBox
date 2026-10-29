import { BgMat, Mat } from './materials';
import { PRNG } from './prng';
import { FLAG_INDESTRUCTIBLE, FLAG_NO_BRUSH, HEIGHT, WIDTH, WorldGrid } from './world';

export type GameMode = 'cozy' | 'alchemist';

/**
 * シード値から初期テラリウム地形を決定論的に生成する
 */
export function generateTerrain(world: WorldGrid, mode: GameMode, customSeed?: number): void {
  const seed = customSeed !== undefined ? customSeed >>> 0 : world.seed;
  world.seed = seed;
  world.clear();
  world.rng = new PRNG(seed);
  const rng = new PRNG(seed ^ 0x9e3779b9);

  const phase1 = rng.next() * Math.PI * 2;
  const phase2 = rng.next() * Math.PI * 2;
  const phase3 = rng.next() * Math.PI * 2;

  const surfaceY = new Int16Array(WIDTH);

  for (let x = 0; x < WIDTH; x++) {
    const nx = x / WIDTH;
    // フラクタル正弦波で心地よい起伏を生成
    let h =
      88 +
      Math.sin(nx * Math.PI * 2.0 + phase1) * 10 +
      Math.sin(nx * Math.PI * 5.0 + phase2) * 5 +
      Math.sin(nx * Math.PI * 11.0 + phase3) * 2;

    if (mode === 'alchemist') {
      // 左側は高台の泉、その右は中央盆地へ滑らかに下る渓谷、中央はテラリウム・コアの盆地
      const distCenter = Math.abs(x - 128);
      if (distCenter < 24) {
        const flatten = 1 - distCenter / 24;
        h = h * (1 - flatten) + 94 * flatten;
      } else if (x <= 51) {
        // 左の高台に貯水くぼみを作る (水面 y=66)
        const pondDist = Math.abs(x - 36);
        h = pondDist < 16 ? 66 + (16 - pondDist) * 0.55 : 65;
      } else if (x <= 56) {
        // せき止め用の薄い土の堤防（消しゴムで削ると水が渓谷を通ってコアへ流れる）
        h = 63;
      } else if (x < 104) {
        // 堤防から中央盆地へ向かう心地よい下りスロープ
        const tSlope = (x - 56) / (104 - 56);
        h = 67 + tSlope * 26 + Math.sin(x * 0.25) * 1.2;
      }
    } else {
      // Cozy Mode: 左寄りに穏やかな池のくぼみを作る
      const lakeDist = Math.abs(x - 68);
      if (lakeDist < 22) {
        h = 92 + Math.cos((lakeDist / 22) * (Math.PI / 2)) * 12;
      }
    }

    surfaceY[x] = Math.max(40, Math.min(HEIGHT - 18, Math.round(h)));
  }

  // 地層の充填
  for (let x = 0; x < WIDTH; x++) {
    const sy = surfaceY[x];
    const stoneDepth = sy + 9 + ((Math.sin(x * 0.17 + phase2) * 3) | 0);

    for (let y = sy; y < HEIGHT; y++) {
      // 最下層ベッドロック
      if (y >= HEIGHT - 3) {
        world.setCell(x, y, Mat.Stone);
        world.flags[world.idx(x, y)] |= FLAG_INDESTRUCTIBLE;
        continue;
      }

      if (y >= stoneDepth) {
        world.setCell(x, y, Mat.Stone);
        world.setBg(x, y, BgMat.StoneWall);
      } else {
        // 水辺周辺は砂または湿潤土
        const isBeach =
          (mode === 'cozy' && Math.abs(x - 68) >= 18 && Math.abs(x - 68) <= 26 && y < sy + 4) ||
          (mode === 'alchemist' && x > 188 && x < 216 && y < sy + 4);
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

  // 地下の発光キノコ洞窟をプロシージャルに掘る
  const caveCenterX = mode === 'alchemist' ? 182 : 168;
  const caveCenterY = 118;
  for (let dy = -11; dy <= 11; dy++) {
    for (let dx = -26; dx <= 26; dx++) {
      const gx = caveCenterX + dx;
      const gy = caveCenterY + dy;
      if (!world.inBounds(gx, gy) || gy >= HEIGHT - 4) continue;
      const norm = (dx * dx) / (26 * 26) + (dy * dy) / (11 * 11);
      if (norm < 0.85 + Math.sin(dx * 0.4) * 0.12) {
        world.setCell(gx, gy, Mat.Air);
        world.setBg(gx, gy, BgMat.StoneWall, 1);
        // 洞窟の底には地下水と湿潤土と発光キノコを配置
        if (dy >= 6) {
          world.setCell(gx, gy, Mat.Water);
        }
      } else if (norm < 1.05 && dy > 2) {
        world.setCell(gx, gy, Mat.WetSoil, 160);
      }
    }
  }
  // 洞窟の縁に発光キノコを生やす
  for (let dx = -22; dx <= 22; dx += 5) {
    const gx = caveCenterX + dx;
    for (let gy = caveCenterY; gy < HEIGHT - 5; gy++) {
      if (world.getMat(gx, gy) === Mat.Air && world.getMat(gx, gy + 1) === Mat.WetSoil) {
        world.setCell(gx, gy, Mat.Mushroom, 20);
        break;
      }
    }
  }

  if (mode === 'cozy') {
    // Cozy Mode: 湖に水を満たし、天然湧水と草木・花を生やす
    for (let x = 47; x <= 89; x++) {
      for (let y = 93; y < surfaceY[x]; y++) {
        world.setCell(x, y, Mat.Water);
      }
      if (surfaceY[x] >= 92) {
        world.setCell(x, surfaceY[x], Mat.WetSoil, 180);
      }
    }
    world.setCell(52, 95, Mat.Spring);
    // 初期の種と発光キノコを水辺に添える
    for (const sx of [42, 95, 114, 142, 205]) {
      const sy = surfaceY[sx];
      world.setCell(sx, sy, Mat.WetSoil, 180);
      world.setCell(sx, sy - 1, Mat.Seed, 10);
    }
    world.setCell(45, surfaceY[45], Mat.WetSoil, 180);
    world.setCell(45, surfaceY[45] - 1, Mat.Mushroom, 15);
  } else {
    // Alchemist Mode: 左高台の泉＋中央の「古代の樹（テラリウム・コア）」生成
    for (let x = 21; x <= 51; x++) {
      for (let y = 66; y < surfaceY[x]; y++) {
        world.setCell(x, y, Mat.Water);
      }
      world.setCell(x, surfaceY[x], Mat.Stone);
    }
    // 高台の湧水石
    world.setCell(25, 68, Mat.Spring);
    world.flags[world.idx(25, 68)] |= FLAG_INDESTRUCTIBLE;

    // 中央にテラリウム・コアと背景の古代樹を構築
    placeTerrariumCore(world, 128, surfaceY[128] - 2);
  }

  world.wakeAll();
}

/**
 * 中央の「古代の樹（テラリウム・コア）」と保護エリアを配置する
 */
export function placeTerrariumCore(world: WorldGrid, cx: number, cy: number): void {
  world.coreX = cx;
  world.coreY = cy;
  world.hasCore = true;

  // 背景に古代樹の幹と枝葉を描画
  for (let dy = -16; dy <= 3; dy++) {
    for (let dx = -12; dx <= 12; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      // 樹冠の楕円と幹
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
