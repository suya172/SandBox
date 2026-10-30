import { BgMat, Mat, MatId } from '../core/materials';
import { HEIGHT, WIDTH, WorldGrid } from '../core/world';

/**
 * プロシージャル・コージー建築システム (Phase 2)
 * 1. 水面や谷をまたぐ木材の「太鼓橋アーチ＆背景支柱」自動生成（流体は裏側を通過可能）
 * 2. 木材十字構造の中心に銅（または直接 RotorHub）を置いた際の「羽根車（水車・風車）」創発
 * 3. 時間経過と湿度に応じた石壁・木材への「苔・ツタ」自動装飾
 */
export function onBlockEdited(
  world: WorldGrid,
  x: number,
  y: number,
  prevMat: MatId,
  newMat: MatId
): void {
  // 1. 羽根車（RotorHub）の削除時は周囲の背景ブレードもクリア
  if (prevMat === Mat.RotorHub && newMat !== Mat.RotorHub) {
    clearRotorBlades(world, x, y);
  }

  // 2. 直接 RotorHub を配置した場合、羽根車のブレードを展開
  if (newMat === Mat.RotorHub) {
    deployRotorBlades(world, x, y);
    return;
  }

  // 3. SPEC 2.2: 木材ブロックの十字構造の中心に「銅」を置くと自動的に「羽根車」へ変化！
  if (newMat === Mat.Copper && isWoodCrossAround(world, x, y)) {
    // 十字の木材を回転ブレードへ昇華させ、中心を RotorHub に変える
    const arms: [number, number][] = [
      [x, y - 1],
      [x, y + 1],
      [x - 1, y],
      [x + 1, y],
    ];
    for (const [ax, ay] of arms) {
      if (world.getMat(ax, ay) === Mat.Wood) {
        world.setCell(ax, ay, Mat.Air);
      }
    }
    world.setCell(x, y, Mat.RotorHub);
    deployRotorBlades(world, x, y);
    return;
  }

  // 4. 木材配置・削除時のプロシージャル太鼓橋＆背景支柱更新
  if (newMat === Mat.Wood || prevMat === Mat.Wood) {
    updateWoodBridgesInRegion(world, Math.max(1, x - 8), Math.min(WIDTH - 2, x + 8), y);
  }
}

/** 上下左右4マスが木材（または羽根車アーム候補）か判定 */
function isWoodCrossAround(world: WorldGrid, x: number, y: number): boolean {
  if (x < 2 || x >= WIDTH - 2 || y < 2 || y >= HEIGHT - 2) return false;
  return (
    world.getMat(x - 1, y) === Mat.Wood &&
    world.getMat(x + 1, y) === Mat.Wood &&
    world.getMat(x, y - 1) === Mat.Wood &&
    world.getMat(x, y + 1) === Mat.Wood
  );
}

/** 羽根車の回転ブレード領域（半径2セル）を背景レイヤーに展開する */
export function deployRotorBlades(world: WorldGrid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy > 5) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      if (world.bgType[world.idx(gx, gy)] === BgMat.None) {
        world.setBg(gx, gy, BgMat.RotorBlade, 0);
      }
    }
  }
}

/** 羽根車撤去時に周囲のブレード背景を取り除く */
function clearRotorBlades(world: WorldGrid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      const i = world.idx(gx, gy);
      if (world.bgType[i] === BgMat.RotorBlade) {
        world.setBg(gx, gy, BgMat.None, 0);
      }
    }
  }
}

/**
 * 横に引かれた木材を検出し、谷や水面をまたいでいる場合に太鼓橋アーチと背景支柱を自動生成する
 */
export function updateWoodBridgesInRegion(
  world: WorldGrid,
  minX: number,
  maxX: number,
  centerY: number
): void {
  const minY = Math.max(1, centerY - 3);
  const maxY = Math.min(HEIGHT - 2, centerY + 3);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const i = world.idx(x, y);
      if (world.type[i] === Mat.Wood) {
        const hasLeft = world.getMat(x - 1, y) === Mat.Wood || world.getMat(x - 1, y + 1) === Mat.Wood || isGroundSupport(world.getMat(x - 1, y));
        const hasRight = world.getMat(x + 1, y) === Mat.Wood || world.getMat(x + 1, y + 1) === Mat.Wood || isGroundSupport(world.getMat(x + 1, y));
        const belowMat = world.getMat(x, y + 1);
        const overOpenOrWater =
          belowMat === Mat.Air ||
          belowMat === Mat.Water ||
          belowMat === Mat.BlightWater ||
          belowMat === Mat.Steam ||
          belowMat === Mat.Miasma ||
          belowMat === Mat.Nectar;

        if (hasLeft && hasRight && overOpenOrWater) {
          // 太鼓橋デッキとしてマーク（上面ハイライト）
          world.meta[i] = 2;
          // 直下にアーチ装飾を設定
          if (y + 1 < HEIGHT && world.bgType[world.idx(x, y + 1)] === BgMat.None) {
            world.setBg(x, y + 1, BgMat.WoodArch, 0);
          }
          // 5マス周期で下方の地面まで木製橋脚（背景支柱）を下ろす
          if (x % 5 === 0) {
            buildBackgroundPillar(world, x, y + 1);
          }
        }
      } else {
        // 木材が消えた場合、孤立した橋アーチや支柱をクリーンアップ
        if (world.bgType[i] === BgMat.WoodArch && world.getMat(x, y - 1) !== Mat.Wood) {
          world.setBg(x, y, BgMat.None, 0);
          clearPillarBelow(world, x, y + 1);
        }
      }
    }
  }
}

function isGroundSupport(mat: MatId): boolean {
  return (
    mat === Mat.Stone ||
    mat === Mat.HardStone ||
    mat === Mat.Soil ||
    mat === Mat.WetSoil ||
    mat === Mat.BlightSoil ||
    mat === Mat.Sand
  );
}

function buildBackgroundPillar(world: WorldGrid, x: number, startY: number): void {
  // 地面に到達できるか最大26マス下まで確認
  let groundY = -1;
  for (let y = startY; y < Math.min(HEIGHT, startY + 26); y++) {
    const m = world.getMat(x, y);
    if (isGroundSupport(m) || m === Mat.Wood) {
      groundY = y;
      break;
    }
  }
  if (groundY === -1) return;

  for (let y = startY; y < groundY; y++) {
    const i = world.idx(x, y);
    if (world.bgType[i] === BgMat.None || world.bgType[i] === BgMat.WoodArch) {
      world.setBg(x, y, y === startY ? BgMat.WoodArch : BgMat.WoodPillar, 0);
    }
  }
}

function clearPillarBelow(world: WorldGrid, x: number, startY: number): void {
  for (let y = startY; y < HEIGHT; y++) {
    const i = world.idx(x, y);
    if (world.bgType[i] === BgMat.WoodPillar || world.bgType[i] === BgMat.WoodArch) {
      world.setBg(x, y, BgMat.None, 0);
    } else {
      break;
    }
  }
}

/**
 * 時間経過と周囲の湿度に応じて、放置された石壁や木材に苔・ツタを自然発生させる (Phase 2)
 */
export function stepProceduralDecor(world: WorldGrid): void {
  // 軽量化のため毎フレーム少数のランダムサンプルに対して環境判定を行う
  for (let s = 0; s < 32; s++) {
    const x = world.rng.nextInt(WIDTH);
    const y = world.rng.nextInt(HEIGHT);
    const i = world.idx(x, y);
    const mat = world.type[i];
    const bg = world.bgType[i];

    if (mat !== Mat.Stone && mat !== Mat.Wood && bg !== BgMat.StoneWall) continue;

    // 高温時は苔が枯れる
    if (world.temp[i] >= 65) {
      if (world.bgMeta[i] > 100) {
        world.bgMeta[i]--;
      }
      continue;
    }

    // 近傍に水・湿潤土・植物・蒸気があるかチェック
    let humid = false;
    for (let dy = -2; dy <= 2 && !humid; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!world.inBounds(x + dx, y + dy)) continue;
        const nm = world.type[world.idx(x + dx, y + dy)];
        if (
          nm === Mat.Water ||
          nm === Mat.WetSoil ||
          nm === Mat.Leaf ||
          nm === Mat.PlantStem ||
          nm === Mat.Mushroom
        ) {
          humid = true;
          break;
        }
      }
    }

    if (humid) {
      const cur = world.bgMeta[i];
      if (cur === 0) {
        world.bgMeta[i] = 101;
      } else if (cur >= 100 && cur < 106) {
        world.bgMeta[i] = cur + 1;
      }
    }
  }
}

