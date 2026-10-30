import {
  BgMat,
  MAT_CATEGORY,
  MAT_DENSITY,
  MAT_DISPERSION,
  MAT_FLAMMABILITY,
  MAT_INSULATOR,
  Mat,
  MatCategory,
  MatId,
} from './materials';
import {
  CHUNKS_X,
  CHUNKS_Y,
  CHUNK_SIZE,
  FLAG_INDESTRUCTIBLE,
  FLAG_UPDATED,
  HEIGHT,
  SIZE,
  WIDTH,
  WorldGrid,
} from './world';

/** 4近傍オフセット */
const DX4 = [0, 1, 0, -1];
const DY4 = [-1, 0, 1, 0];

/**
 * 1フレーム分のセルオートマトン物理・化学・植物シミュレーションを実行する
 */
export function stepSimulation(world: WorldGrid): void {
  world.tick++;
  // 昼夜サイクルの進行（約3600フレーム = 60秒で1日経過）
  const prevTime = world.timeOfDay;
  world.timeOfDay += 1 / 3600;
  if (world.timeOfDay >= 1.0) {
    world.timeOfDay -= 1.0;
    world.dayCount++;
  }
  if (prevTime < 0.25 && world.timeOfDay >= 0.25) {
    world.onDawn?.(world.dayCount);
  }

  // 16フレームに1回、低解像度ライトマップを更新（ヘッドレス時やカゲむし・瘴気霧の光判定用）
  if ((world.tick & 15) === 0) {
    world.chunkNextActive.fill(1);
    world.updateLightField();
  }

  world.beginStep();

  const reverseX = (world.tick & 1) === 1;

  // 下のチャンク行から上のチャンク行へ走査（重力落下に最適化）
  for (let cy = CHUNKS_Y - 1; cy >= 0; cy--) {
    for (let cxi = 0; cxi < CHUNKS_X; cxi++) {
      const cx = reverseX ? CHUNKS_X - 1 - cxi : cxi;
      if (world.chunkActive[cy * CHUNKS_X + cx] === 0) continue;

      const startY = (cy + 1) * CHUNK_SIZE - 1;
      const endY = cy * CHUNK_SIZE;
      const xStart = cx * CHUNK_SIZE;

      for (let y = startY; y >= endY; y--) {
        const rowFlip = ((y + world.tick) & 1) === 1;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const x = rowFlip ? xStart + (CHUNK_SIZE - 1 - lx) : xStart + lx;
          const i = (y << 8) + x;
          if ((world.flags[i] & FLAG_UPDATED) !== 0) continue;

          const mat = world.type[i] as MatId;
          if (mat === Mat.Air) continue;

          updateCell(world, x, y, i, mat);
        }
      }
    }
  }

  // 15Hz（4フレームに1回）の熱伝導・環境温度緩和パス
  if ((world.tick & 3) === 0) {
    stepThermal(world);
  }
}

/**
 * 個別セルの物理・化学更新
 */
function updateCell(world: WorldGrid, x: number, y: number, i: number, mat: MatId): void {
  const cat = MAT_CATEGORY[mat];

  if (cat === MatCategory.Powder) {
    updatePowder(world, x, y, i, mat);
    return;
  }

  if (cat === MatCategory.Liquid) {
    updateLiquid(world, x, y, i, mat);
    return;
  }

  if (cat === MatCategory.Gas) {
    updateGas(world, x, y, i, mat);
    return;
  }

  if (cat === MatCategory.Flora) {
    updateFlora(world, x, y, i, mat);
    return;
  }

  if (cat === MatCategory.Energy) {
    updateEnergy(world, x, y, i, mat);
    return;
  }

  // 固定固体・特殊ブロックの反応
  if (mat === Mat.Wood) {
    if (world.temp[i] >= 280 && world.rng.chance(0.15)) {
      world.setCell(x, y, Mat.Fire, 75, 520);
    }
  } else if (mat === Mat.Spring) {
    // meta === 1 は地下硬岩に封じられた休眠湧水石：周囲が開通するかパイプ/ポンプ/通電が来ると稼働開始 (meta = 0)
    if (world.meta[i] === 1) {
      let awakened = world.charge[i] >= 40;
      for (let d = 0; d < 4 && !awakened; d++) {
        const nx = x + DX4[d];
        const ny = y + DY4[d];
        if (!world.inBounds(nx, ny)) continue;
        const ni = world.idx(nx, ny);
        const nm = world.type[ni];
        if (nm === Mat.Air || nm === Mat.Pipe || nm === Mat.Pump || world.charge[ni] >= 40) {
          awakened = true;
        }
      }
      if (awakened) {
        world.meta[i] = 0;
      } else {
        return;
      }
    }

    // 稼働中の天然水源：周期的に下・左右・上（被圧湧出）の空きセルへ清水を湧出
    if ((world.tick + x * 7) % 21 === 0) {
      const targets: [number, number][] = [
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
      ];
      for (const [nx, ny] of targets) {
        if (world.inBounds(nx, ny) && world.type[world.idx(nx, ny)] === Mat.Air) {
          world.setCell(nx, ny, Mat.Water, 0, 18);
          break;
        }
      }
    }
    world.wakeAround(x, y);
  }
}

/**
 * 粉体・粒体マテリアル（砂・土・湿潤土・灰・黒曜石・星のかけら・種・果実）の更新
 */
function updatePowder(world: WorldGrid, x: number, y: number, i: number, mat: MatId): void {
  const temp = world.temp[i];

  // 1. テラリウム・コアへの納品チェック（果実・黒曜石・星のかけら）
  if (mat === Mat.Fruit || mat === Mat.Obsidian || mat === Mat.StarShard) {
    if (touchesCore(world, x, y)) {
      const kind =
        mat === Mat.Fruit ? 'fruit' : mat === Mat.Obsidian ? 'obsidian' : 'star_shard';
      world.onCoreDeliver?.(kind, 1);
      world.setCell(x, y, Mat.Air);
      return;
    }
  }

  // 2. マテリアル固有の相転移・化学反応
  if (mat === Mat.Sand) {
    // 高熱（溶岩や雷）で砂がガラスに変化
    if (temp >= 550) {
      world.setCell(x, y, Mat.Glass, 0, temp);
      return;
    }
  } else if (mat === Mat.WetSoil) {
    // 高温乾燥で通常の土に戻る
    if (temp >= 95 && world.rng.chance(0.08)) {
      world.setCell(x, y, Mat.Soil, 0, temp);
      return;
    }
    // 隣接する乾いた土へ水分を少しずつ浸透させる
    if (world.meta[i] > 40 && world.rng.chance(0.06)) {
      const dir = world.rng.nextInt(4);
      const nx = x + DX4[dir];
      const ny = y + DY4[dir];
      if (world.inBounds(nx, ny)) {
        const ni = world.idx(nx, ny);
        if (world.type[ni] === Mat.Soil) {
          const half = world.meta[i] >> 1;
          world.meta[i] -= half;
          world.setCell(nx, ny, Mat.WetSoil, half + 20, world.temp[ni]);
        }
      }
    }
  } else if (mat === Mat.BlightSoil) {
    // 腐敗土：近傍2マス以内に発光キノコまたは灰があれば菌糸・ミネラル浄化で湿潤土へ再生
    let purified = false;
    for (let dy = -2; dy <= 2 && !purified; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!world.inBounds(x + dx, y + dy)) continue;
        const nm = world.type[world.idx(x + dx, y + dy)];
        if (nm === Mat.Mushroom || nm === Mat.Ash) {
          purified = true;
          break;
        }
      }
    }
    if (purified) {
      if (world.rng.chance(0.08)) {
        world.setCell(x, y, Mat.WetSoil, 170, temp);
        return;
      }
      // 浄化源が隣接している間はチャンクスリープを防いで継続反応させる
      world.wakeAround(x, y);
    }
  } else if (mat === Mat.Ash) {
    // 灰（肥料・浄化材）が土や腐敗土に触れると栄養豊富な湿潤土へ同化
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const bMat = world.type[ni];
      if (bMat === Mat.Soil || bMat === Mat.WetSoil || bMat === Mat.BlightSoil) {
        world.setCell(nx, ny, Mat.WetSoil, 220, world.temp[ni]);
        world.setCell(x, y, Mat.Air);
        return;
      }
      if (bMat === Mat.BlightWater) {
        world.setCell(nx, ny, Mat.Water, 0, world.temp[ni]);
        world.setCell(x, y, Mat.Air);
        return;
      }
    }
  } else if (mat === Mat.Seed) {
    if (temp >= 200) {
      world.setCell(x, y, Mat.Fire, 35, 450);
      return;
    }
    // 湿潤土の上に着地したら発芽する
    if (y + 1 < HEIGHT) {
      const bi = world.idx(x, y + 1);
      if (world.type[bi] === Mat.WetSoil && world.rng.chance(0.18)) {
        const heightPotential = 5 + world.rng.nextInt(6);
        world.setCell(x, y, Mat.PlantStem, heightPotential, temp);
        return;
      }
    }
  } else if (mat === Mat.Fruit) {
    if (temp >= 220) {
      world.setCell(x, y, Mat.Fire, 40, 480);
      return;
    }
    // 枝（PlantStem / Leaf / Flower）にくっついている間は熟すまで落ちない（meta < 90）
    if (world.meta[i] < 90 && hasAdjacentFloraSupport(world, x, y)) {
      if (world.rng.chance(0.04)) {
        world.meta[i]++;
        world.wakeAround(x, y);
      }
      return;
    }
  }

  // 3. 重力落下（真下 → 左右斜め下）
  if (y + 1 >= HEIGHT) return;
  const myDensity = MAT_DENSITY[mat];

  const belowIdx = world.idx(x, y + 1);
  if (canDisplace(world, belowIdx, myDensity)) {
    world.swapCells(i, belowIdx);
    return;
  }

  // 湿潤土・土・腐敗土は一定の安息角を保ち、崩れすぎないようにする
  if ((mat === Mat.WetSoil || mat === Mat.Soil || mat === Mat.BlightSoil) && world.rng.chance(0.45)) {
    return;
  }

  const firstLeft = world.rng.chance(0.5);
  const dx1 = firstLeft ? -1 : 1;
  const dx2 = -dx1;

  if (x + dx1 >= 0 && x + dx1 < WIDTH) {
    const diag1 = world.idx(x + dx1, y + 1);
    const side1 = world.idx(x + dx1, y);
    if (canPassDiagonal(world, side1) && canDisplace(world, diag1, myDensity)) {
      world.swapCells(i, diag1);
      return;
    }
  }
  if (x + dx2 >= 0 && x + dx2 < WIDTH) {
    const diag2 = world.idx(x + dx2, y + 1);
    const side2 = world.idx(x + dx2, y);
    if (canPassDiagonal(world, side2) && canDisplace(world, diag2, myDensity)) {
      world.swapCells(i, diag2);
      return;
    }
  }
}

/**
 * 液体マテリアル（水・溶岩・蜜）の更新
 */
function updateLiquid(world: WorldGrid, x: number, y: number, i: number, mat: MatId): void {
  const temp = world.temp[i];

  // 1. テラリウム・コアへの液体納品チェック（水・蜜は納品＆微回復、汚染水はコア汚染ダメージ）
  if ((mat === Mat.Water || mat === Mat.Nectar) && touchesCore(world, x, y)) {
    world.onCoreDeliver?.(mat === Mat.Water ? 'water' : 'nectar', 1);
    if (world.rng.chance(0.25)) world.healCore(1);
    world.setCell(x, y, Mat.Air);
    return;
  }
  if (mat === Mat.BlightWater && touchesCore(world, x, y)) {
    world.damageCore(2);
    world.setCell(x, y, Mat.Air);
    return;
  }

  // 2. 液体ごとの化学反応・相転移
  if (mat === Mat.BlightWater) {
    // 沸騰蒸留すると清浄な蒸気へ変わる
    if (temp >= 100) {
      world.setCell(x, y, Mat.Steam, 130, Math.max(110, temp));
      return;
    }
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const nMat = world.type[ni];

      // 発光キノコまたは灰によるバイオ浄化、および砂層による濾過浄化
      if (nMat === Mat.Mushroom || nMat === Mat.Ash) {
        world.setCell(x, y, Mat.Water, 0, temp);
        if (nMat === Mat.Ash && world.rng.chance(0.4)) {
          world.setCell(nx, ny, Mat.Air);
        }
        return;
      }
      if (nMat === Mat.Sand && world.rng.chance(0.18)) {
        world.setCell(x, y, Mat.Water, 0, temp);
        return;
      }
      // 通常の土壌を腐敗土に変え、通常植物を枯死させる
      if ((nMat === Mat.Soil || nMat === Mat.WetSoil) && world.rng.chance(0.1)) {
        world.setCell(nx, ny, Mat.BlightSoil, 0, world.temp[ni]);
      } else if (
        (nMat === Mat.PlantStem || nMat === Mat.Leaf || nMat === Mat.Flower || nMat === Mat.Seed) &&
        world.rng.chance(0.16)
      ) {
        world.setCell(nx, ny, Mat.Air);
      } else if (nMat === Mat.Magma) {
        world.setCell(nx, ny, Mat.Obsidian, 0, 140);
        world.setCell(x, y, Mat.Steam, 140, 130);
        return;
      }
    }
  } else if (mat === Mat.Water) {
    // 沸点以上で蒸気に気化
    if (temp >= 100) {
      world.setCell(x, y, Mat.Steam, 140, Math.max(110, temp));
      return;
    }

    // 4近傍の相互作用チェック（溶岩・火・乾いた土）
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const nMat = world.type[ni];

      if (nMat === Mat.Magma) {
        // 水 + 溶岩 = 黒曜石 + 蒸気
        world.setCell(nx, ny, Mat.Obsidian, 0, 140);
        world.setCell(x, y, Mat.Steam, 150, 130);
        return;
      }
      if (nMat === Mat.Fire) {
        // 消火して蒸気へ
        world.setCell(nx, ny, Mat.Air);
        world.setCell(x, y, Mat.Steam, 120, 108);
        return;
      }
      if (nMat === Mat.Soil) {
        // 土を湿潤土へ変える（水1滴で複数の土を潤せるよう確率消費）
        world.setCell(nx, ny, Mat.WetSoil, 150, world.temp[ni]);
        if (world.rng.chance(0.28)) {
          world.setCell(x, y, Mat.Air);
          return;
        }
      }
    }
  } else if (mat === Mat.Magma) {
    // 溶岩が極度に冷えた場合は石または黒曜石へ凝固
    if (temp < 300) {
      world.setCell(x, y, Mat.Obsidian, 0, temp);
      return;
    }

    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const nMat = world.type[ni];

      if (nMat === Mat.Water) {
        world.setCell(x, y, Mat.Obsidian, 0, 150);
        world.setCell(nx, ny, Mat.Steam, 150, 130);
        return;
      }
      if (nMat === Mat.Sand && world.rng.chance(0.25)) {
        world.setCell(nx, ny, Mat.Glass, 0, 620);
      } else if (MAT_FLAMMABILITY[nMat] > 0 && (world.flags[ni] & FLAG_INDESTRUCTIBLE) === 0) {
        if (nMat === Mat.Nectar) {
          world.setCell(nx, ny, Mat.Fire, 110, 780);
        } else {
          world.setCell(nx, ny, Mat.Fire, 65, 580);
        }
      }
    }

    // 溶岩は高粘度（2フレームに1回移動）
    if ((world.tick & 1) === 1) {
      world.wakeAround(x, y);
      return;
    }
  } else if (mat === Mat.Nectar) {
    // 蜜は火や高熱で高火力燃焼する
    if (temp >= 180) {
      world.setCell(x, y, Mat.Fire, 120, 780);
      return;
    }
    // 高粘度のためゆっくり移動
    if (world.tick % 3 !== 0) {
      world.wakeAround(x, y);
      return;
    }
  }

  // 3. 流体移動（真下 → 斜め下 → 横方向分散）
  const myDensity = MAT_DENSITY[mat];
  if (y + 1 < HEIGHT) {
    const belowIdx = world.idx(x, y + 1);
    if (canDisplace(world, belowIdx, myDensity)) {
      world.swapCells(i, belowIdx);
      return;
    }

    const goLeft = world.rng.chance(0.5);
    const dxA = goLeft ? -1 : 1;
    const dxB = -dxA;

    if (x + dxA >= 0 && x + dxA < WIDTH) {
      const diagA = world.idx(x + dxA, y + 1);
      if (canDisplace(world, diagA, myDensity)) {
        world.swapCells(i, diagA);
        return;
      }
    }
    if (x + dxB >= 0 && x + dxB < WIDTH) {
      const diagB = world.idx(x + dxB, y + 1);
      if (canDisplace(world, diagB, myDensity)) {
        world.swapCells(i, diagB);
        return;
      }
    }
  }

  // 横方向の流動拡散
  const disp = MAT_DISPERSION[mat];
  const dir = (world.meta[i] & 1) === 1 ? -1 : 1;
  const tryDirs = world.rng.chance(0.8) ? [dir, -dir] : [-dir, dir];

  for (const d of tryDirs) {
    let bestX = -1;
    for (let step = 1; step <= disp; step++) {
      const nx = x + d * step;
      if (nx < 0 || nx >= WIDTH) break;
      const ni = world.idx(nx, y);
      if (canDisplace(world, ni, myDensity)) {
        bestX = nx;
      } else {
        break;
      }
    }
    if (bestX !== -1) {
      world.meta[i] = d === -1 ? 1 : 0;
      world.swapCells(i, world.idx(bestX, y));
      return;
    }
  }
}

/**
 * 気体マテリアル（蒸気・胞子・煙）の更新
 */
function updateGas(world: WorldGrid, x: number, y: number, i: number, mat: MatId): void {
  if (mat === Mat.Steam) {
    // 発電シダ (VoltFern) に蒸気が触れると微弱発電を促す
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const nMat = world.type[ni];
      if (nMat === Mat.VoltFern) {
        world.charge[ni] = Math.min(255, world.charge[ni] + 45);
      } else if ((nMat === Mat.Glass || nMat === Mat.Stone) && world.temp[ni] <= 38) {
        // 冷たいガラス天井や岩盤に触れると急速に冷やされて水滴（雨）に凝結！
        world.temp[i] -= 18;
      }
    }

    // 上空低温域に到達するか、温度が下がったら水に戻って雨が降る（水循環の創発）
    if (world.meta[i] > 0) world.meta[i]--;
    const atColdSky = y <= 16;
    if (world.temp[i] <= 45 || (atColdSky && world.rng.chance(0.18)) || world.meta[i] === 0) {
      world.setCell(x, y, Mat.Water, 0, 22);
      return;
    }
  } else if (mat === Mat.Spore) {
    if (world.temp[i] >= 160) {
      world.setCell(x, y, Mat.Fire, 25, 420);
      return;
    }
    // 暗い（夜間または背景壁のある洞窟・日陰）湿潤土に触れると発光キノコを生やす
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      if (world.type[ni] === Mat.WetSoil) {
        const isDark = world.isNight() || world.bgType[i] !== BgMat.None;
        if (isDark && y > 0 && world.type[i] === Mat.Spore) {
          world.setCell(x, y, Mat.Mushroom, 20, 20);
          return;
        }
      }
    }

    if (world.meta[i] > 0) {
      world.meta[i]--;
    } else {
      world.setCell(x, y, Mat.Air);
      return;
    }

    // 胞子は風に乗ってランダムに漂う
    if (world.rng.chance(0.5)) {
      const rdx = world.rng.rangeInt(-1, 1);
      const rdy = world.rng.rangeInt(-1, 1);
      const nx = x + rdx;
      const ny = y + rdy;
      if (world.inBounds(nx, ny) && world.type[world.idx(nx, ny)] === Mat.Air) {
        world.swapCells(i, world.idx(nx, ny));
      } else {
        world.wakeAround(x, y);
      }
      return;
    }
  } else if (mat === Mat.Smoke) {
    if (world.meta[i] > 0) {
      world.meta[i]--;
    } else {
      world.setCell(x, y, Mat.Air);
      return;
    }
  } else if (mat === Mat.Miasma) {
    // 瘴気霧：日中の太陽光、高温 (>=45℃)、または強い光源 (lightLuma >= 50) で霧散する
    if (
      world.temp[i] >= 45 ||
      (!world.isNight() && world.rng.chance(0.15)) ||
      (world.getLightAt(x, y) >= 50 && world.rng.chance(0.3))
    ) {
      world.setCell(x, y, Mat.Air);
      return;
    }
    if (world.meta[i] > 0) {
      world.meta[i]--;
    } else {
      world.setCell(x, y, Mat.Air);
      return;
    }
    // 暗所の露出した若葉を低確率でしおれさせる
    if ((world.tick & 7) === 0) {
      for (let d = 0; d < 4; d++) {
        const nx = x + DX4[d];
        const ny = y + DY4[d];
        if (!world.inBounds(nx, ny)) continue;
        const nm = world.type[world.idx(nx, ny)];
        if ((nm === Mat.Leaf || nm === Mat.Flower) && world.rng.chance(0.03)) {
          world.setCell(nx, ny, Mat.Air);
        }
      }
    }
    // 地表近くを横に漂う動きを優先
    if (world.rng.chance(0.65)) {
      const rdx = world.rng.chance(0.5) ? -1 : 1;
      const nx = x + rdx;
      if (world.inBounds(nx, y) && world.type[world.idx(nx, y)] === Mat.Air) {
        world.swapCells(i, world.idx(nx, y));
      } else {
        world.wakeAround(x, y);
      }
      return;
    }
  }

  // 気体の上昇移動（真上 → 斜め上 → 左右拡散）
  const myDensity = MAT_DENSITY[mat];
  if (y > 0) {
    const upIdx = world.idx(x, y - 1);
    if (canGasRiseInto(world, upIdx, myDensity) && world.rng.chance(0.75)) {
      world.swapCells(i, upIdx);
      return;
    }
    const dir = world.rng.chance(0.5) ? -1 : 1;
    for (const dx of [dir, -dir]) {
      const nx = x + dx;
      if (nx >= 0 && nx < WIDTH) {
        const diagUp = world.idx(nx, y - 1);
        if (canGasRiseInto(world, diagUp, myDensity)) {
          world.swapCells(i, diagUp);
          return;
        }
      }
    }
  }

  // 横拡散
  const sideDx = world.rng.chance(0.5) ? -1 : 1;
  if (x + sideDx >= 0 && x + sideDx < WIDTH) {
    const sideIdx = world.idx(x + sideDx, y);
    if (world.type[sideIdx] === Mat.Air || world.type[sideIdx] === Mat.GateOpen) {
      world.swapCells(i, sideIdx);
      return;
    }
  }
  world.wakeAround(x, y);
}

/**
 * 植物マテリアル（茎・葉・花・発光キノコ・発電シダ）の更新
 */
function updateFlora(world: WorldGrid, x: number, y: number, i: number, mat: MatId): void {
  const temp = world.temp[i];

  // 高熱による自然発火
  if (temp >= 240 && world.rng.chance(0.2)) {
    world.setCell(x, y, Mat.Fire, 55, 500);
    return;
  }

  if (mat === Mat.PlantStem) {
    const remaining = world.meta[i];
    if (remaining > 0) {
      // 成長途中の茎はチャンクを起床させ続け、素数周期で成長判定を行う
      world.wakeAround(x, y);
      if ((world.tick + x * 13 + y * 7) % 19 === 0 && world.rng.chance(0.55)) {
        if (hasMoistureSupport(world, x, y) && y > 6) {
          const growDx = world.rng.chance(0.25) ? world.rng.rangeInt(-1, 1) : 0;
          const gx = Math.max(1, Math.min(WIDTH - 2, x + growDx));
          const gy = y - 1;
          const gi = world.idx(gx, gy);

          if (world.type[gi] === Mat.Air) {
            if (remaining === 1) {
              // 先端に花または葉をつける
              world.setCell(gx, gy, world.rng.chance(0.8) ? Mat.Flower : Mat.Leaf, 20, temp);
            } else {
              world.setCell(gx, gy, Mat.PlantStem, remaining - 1, temp);
              // 途中に葉を広げる
              const leafSide = world.rng.chance(0.5) ? -1 : 1;
              if (
                world.inBounds(x + leafSide, y) &&
                world.type[world.idx(x + leafSide, y)] === Mat.Air
              ) {
                world.setCell(x + leafSide, y, Mat.Leaf, 0, temp);
              }
            }
            world.meta[i] = 0; // この節は成長完了
          }
        }
      }
    }
  } else if (mat === Mat.Flower) {
    // 花は定期的に「蜜 (Nectar)」または「果実 (Fruit)」を生成する（16と互いに素な周期）
    if ((world.tick + x * 19 + y * 7) % 73 === 0 && world.rng.chance(0.4)) {
      const candidates: [number, number][] = [
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
      ];
      for (const [nx, ny] of candidates) {
        if (world.inBounds(nx, ny) && world.type[world.idx(nx, ny)] === Mat.Air) {
          if (world.rng.chance(0.62)) {
            world.setCell(nx, ny, Mat.Nectar, 0, 22);
          } else {
            world.setCell(nx, ny, Mat.Fruit, 20, 22);
          }
          break;
        }
      }
    }
  } else if (mat === Mat.Mushroom) {
    // 発光キノコは定期的に胞子をふわっと放出（16と互いに素な周期）
    if ((world.tick + x * 23 + y * 5) % 97 === 0 && world.rng.chance(0.35)) {
      if (y > 1 && world.type[world.idx(x, y - 1)] === Mat.Air) {
        world.setCell(x, y - 1, Mat.Spore, 150, 20);
      }
    }
  } else if (mat === Mat.VoltFern) {
    // 発電シダ：下の湿潤土から少しずつ成長しつつ、風や蒸気・雷で帯電
    if (world.meta[i] > 0) {
      world.wakeAround(x, y);
      if ((world.tick + x * 11) % 23 === 0 && y > 4) {
        if (world.type[world.idx(x, y - 1)] === Mat.Air) {
          world.setCell(x, y - 1, Mat.VoltFern, world.meta[i] - 1, temp);
          world.meta[i] = 0;
        }
      }
    }
  }
}

/**
 * エネルギー体（火・雷）の更新
 */
function updateEnergy(world: WorldGrid, x: number, y: number, i: number, mat: MatId): void {
  if (mat === Mat.Fire) {
    if (world.meta[i] === 0) {
      world.meta[i] = 45;
    }
    world.temp[i] = Math.max(world.temp[i], 480);

    let burnedOrganic = false;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const nMat = world.type[ni];

      if (nMat === Mat.Water) {
        world.setCell(nx, ny, Mat.Steam, 120, 110);
        world.setCell(x, y, Mat.Air);
        return;
      }

      if (nMat === Mat.Sand && world.temp[i] >= 650 && world.rng.chance(0.15)) {
        world.setCell(nx, ny, Mat.Glass, 0, 620);
        continue;
      }

      const flam = MAT_FLAMMABILITY[nMat];
      if (flam > 0 && (world.flags[ni] & FLAG_INDESTRUCTIBLE) === 0) {
        world.temp[ni] += 45;
        if (world.rng.chance(flam * 0.0045)) {
          if (nMat === Mat.Nectar) {
            // 蜜は高火力で燃焼！
            world.setCell(nx, ny, Mat.Fire, 110, 780);
          } else {
            burnedOrganic =
              nMat === Mat.Wood ||
              nMat === Mat.PlantStem ||
              nMat === Mat.Leaf ||
              nMat === Mat.Flower;
            world.setCell(nx, ny, Mat.Fire, 55, 540);
            if (burnedOrganic && world.rng.chance(0.35)) {
              // 燃え尽きた後に肥料となる灰を生むフラグとして上位ビットを活用
              world.meta[ni] = 180;
            }
          }
        }
      }
    }

    // 寿命減衰（meta >= 140 の場合は有機物由来の炎なので消滅時に灰になりやすい）
    const isAshBearing = world.meta[i] >= 140;
    const life = isAshBearing ? world.meta[i] - 140 : world.meta[i];
    if (life <= 2) {
      if (isAshBearing && world.rng.chance(0.5)) {
        world.setCell(x, y, Mat.Ash, 0, 80);
      } else if (world.rng.chance(0.35)) {
        world.setCell(x, y, Mat.Smoke, 55, 95);
      } else {
        world.setCell(x, y, Mat.Air);
      }
      return;
    }
    world.meta[i] = (isAshBearing ? 140 : 0) + (life - 2);

    // 炎の揺らぎ上昇
    if (y > 0 && world.rng.chance(0.45)) {
      const dx = world.rng.rangeInt(-1, 1);
      const nx = x + dx;
      if (nx >= 0 && nx < WIDTH) {
        const upIdx = world.idx(nx, y - 1);
        if (world.type[upIdx] === Mat.Air) {
          world.swapCells(i, upIdx);
          return;
        }
      }
    }
    world.wakeAround(x, y);
  } else if (mat === Mat.Lightning) {
    // 雷：下方向へ高速に枝分かれ放電し、砂をガラス化・導電体と発電シダに大電力を供給
    if (world.meta[i] === 0) {
      // 新規配置された雷は初期寿命を付与し、下へ稲妻を伸ばす
      let ly = y + 1;
      let lx = x;
      let steps = 0;
      while (ly < HEIGHT && steps < 28) {
        const li = world.idx(lx, ly);
        const lMat = world.type[li];
        if (lMat === Mat.Air) {
          world.setCell(lx, ly, Mat.Lightning, 4, 700);
          world.flags[li] |= FLAG_UPDATED;
          lx = Math.max(0, Math.min(WIDTH - 1, lx + world.rng.rangeInt(-1, 1)));
          ly++;
          steps++;
        } else {
          strikeTargetWithLightning(world, lx, ly, li, lMat as MatId);
          break;
        }
      }
      world.meta[i] = 4;
    }

    for (let d = 0; d < 4; d++) {
      const nx = x + DX4[d];
      const ny = y + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      const nMat = world.type[ni] as MatId;
      if (nMat !== Mat.Air && nMat !== Mat.Lightning) {
        strikeTargetWithLightning(world, nx, ny, ni, nMat);
      }
    }

    world.meta[i]--;
    if (world.meta[i] <= 0) {
      world.setCell(x, y, Mat.Air);
    } else {
      world.wakeAround(x, y);
    }
  }
}

function strikeTargetWithLightning(
  world: WorldGrid,
  x: number,
  y: number,
  i: number,
  mat: MatId
): void {
  world.temp[i] = Math.min(1000, world.temp[i] + 450);
  if (mat === Mat.Sand) {
    world.setCell(x, y, Mat.Glass, 0, 680);
  } else if (
    mat === Mat.VoltFern ||
    mat === Mat.Copper ||
    mat === Mat.Battery ||
    mat === Mat.WeatherAntenna
  ) {
    world.charge[i] = 255;
  } else if (mat === Mat.Water) {
    world.charge[i] = 220;
  } else if (MAT_FLAMMABILITY[mat] > 0 && (world.flags[i] & FLAG_INDESTRUCTIBLE) === 0) {
    world.setCell(x, y, Mat.Fire, 60, 620);
  }
}

/**
 * 15Hz の熱伝導および環境気温への緩和パス
 * Glass (MAT_INSULATOR === 1) は熱伝導を遮断し、温室や断熱壁として機能する
 */
function stepThermal(world: WorldGrid): void {
  const skyCold = 8 + world.ambientTempOffset;
  const groundAmbient =
    (world.isNight() ? 16 : 24) + world.ambientTempOffset;

  for (let y = 0; y < HEIGHT; y++) {
    const targetAmbient = y < 22 ? skyCold : groundAmbient;
    const rowOffset = y << 8;

    for (let x = 0; x < WIDTH; x++) {
      const i = rowOffset + x;
      const mat = world.type[i];

      // 溶岩や火は熱源を維持
      if (mat === Mat.Magma) {
        if (world.temp[i] < 780) world.temp[i] += 8;
      } else if (mat === Mat.Fire) {
        if (world.temp[i] < 500) world.temp[i] = 500;
      }

      if (MAT_INSULATOR[mat] === 1) continue;

      // 右隣・下隣との熱交換（対称ペア処理で高速化）
      if (x + 1 < WIDTH) {
        const ri = i + 1;
        if (MAT_INSULATOR[world.type[ri]] === 0) {
          const diff = world.temp[i] - world.temp[ri];
          if (diff > 3 || diff < -3) {
            const transfer = (diff * 0.18) | 0;
            world.temp[i] -= transfer;
            world.temp[ri] += transfer;
            if (Math.abs(diff) > 25) {
              world.wakeAround(x, y);
            }
          }
        }
      }

      if (y + 1 < HEIGHT) {
        const bi = i + WIDTH;
        if (MAT_INSULATOR[world.type[bi]] === 0) {
          const diff = world.temp[i] - world.temp[bi];
          if (diff > 3 || diff < -3) {
            const transfer = (diff * 0.18) | 0;
            world.temp[i] -= transfer;
            world.temp[bi] += transfer;
          }
        }
      }

      // 外気温への緩やかな緩和（Alchemist 東砂丘ゾーンは日中高温になり、ガラス屋根で遮蔽可能）
      if (mat === Mat.Air || mat === Mat.Steam) {
        let localAmbient = targetAmbient;
        if (world.hasCore && !world.isNight() && x >= 164 && y >= 32 && y <= 98) {
          localAmbient += 18;
        }
        const dAmb = localAmbient - world.temp[i];
        if (dAmb !== 0) {
          world.temp[i] += Math.sign(dAmb) * Math.max(1, Math.abs((dAmb * 0.06) | 0));
        }
      } else if (
        mat === Mat.Water &&
        world.hasCore &&
        !world.isNight() &&
        x >= 164 &&
        y < 98 &&
        y > 4 &&
        world.type[i - WIDTH] === Mat.Air &&
        world.rng.chance(0.012)
      ) {
        // 東の灼熱砂丘で上空にガラス断熱ドームがない露出水滴は日射で少しずつ蒸発する
        let hasCanopy = false;
        for (let cy = y - 1; cy >= Math.max(2, y - 24); cy -= 2) {
          const cm = world.type[(cy << 8) + x];
          if (cm === Mat.Glass || cm === Mat.Stone || cm === Mat.Wood || cm === Mat.HardStone) {
            hasCanopy = true;
            break;
          }
        }
        if (!hasCanopy) {
          world.setCell(x, y, Mat.Steam, 95, 105);
        }
      }
    }
  }

  // 環境熱波（Solar Heatwave）発生時、高温乾燥した植物がごくまれに自然発火
  if (world.ambientTempOffset >= 25) {
    for (let k = 0; k < 12; k++) {
      const rx = world.rng.nextInt(WIDTH);
      const ry = world.rng.nextInt(HEIGHT);
      const ri = world.idx(rx, ry);
      const rMat = world.type[ri];
      if (
        (rMat === Mat.Leaf || rMat === Mat.Flower) &&
        world.temp[ri] >= 46 &&
        world.rng.chance(0.015)
      ) {
        world.setCell(rx, ry, Mat.Fire, 50, 500);
      }
    }
  }

  // チャンク外の境界熱変化を取りこぼさないよう再検証
  for (let i = 0; i < SIZE; i += 64) {
    if (world.temp[i] >= 100 && world.type[i] === Mat.Water) {
      world.wakeAround(i & 0xff, i >> 8);
    }
  }
}

/** 移動先に侵入・置換可能か判定 */
function canDisplace(world: WorldGrid, targetIdx: number, moverDensity: number): boolean {
  if ((world.flags[targetIdx] & FLAG_UPDATED) !== 0) return false;
  const targetMat = world.type[targetIdx];
  if (targetMat === Mat.Air || targetMat === Mat.GateOpen) return true;
  const targetCat = MAT_CATEGORY[targetMat];
  if (targetCat === MatCategory.Liquid || targetCat === MatCategory.Gas) {
    return moverDensity > MAT_DENSITY[targetMat];
  }
  return false;
}

/** 斜め移動時に横の壁で完全に塞がれていないか判定 */
function canPassDiagonal(world: WorldGrid, sideIdx: number): boolean {
  const mat = world.type[sideIdx];
  const cat = MAT_CATEGORY[mat];
  return cat !== MatCategory.Solid && cat !== MatCategory.Machine;
}

/** 気体が上昇置換可能か判定 */
function canGasRiseInto(world: WorldGrid, targetIdx: number, gasDensity: number): boolean {
  if ((world.flags[targetIdx] & FLAG_UPDATED) !== 0) return false;
  const targetMat = world.type[targetIdx];
  if (targetMat === Mat.Air || targetMat === Mat.GateOpen) return true;
  const targetCat = MAT_CATEGORY[targetMat];
  if (targetCat === MatCategory.Gas) {
    return gasDensity < MAT_DENSITY[targetMat];
  }
  return false;
}

/** 4近傍にテラリウム・コアがあるか判定 */
function touchesCore(world: WorldGrid, x: number, y: number): boolean {
  if (!world.hasCore) return false;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX4[d];
    const ny = y + DY4[d];
    if (world.inBounds(nx, ny) && world.type[world.idx(nx, ny)] === Mat.Core) {
      return true;
    }
  }
  return false;
}

/** 植物が枝に支えられているか判定 */
function hasAdjacentFloraSupport(world: WorldGrid, x: number, y: number): boolean {
  for (let d = 0; d < 4; d++) {
    const nx = x + DX4[d];
    const ny = y + DY4[d];
    if (!world.inBounds(nx, ny)) continue;
    const m = world.type[world.idx(nx, ny)];
    if (m === Mat.PlantStem || m === Mat.Leaf || m === Mat.Flower) return true;
  }
  return false;
}

/** 植物の成長に必要な水分または根の繋がりがあるか判定（斜め成長にも対応） */
function hasMoistureSupport(world: WorldGrid, x: number, y: number): boolean {
  let curX = x;
  for (let dy = 1; dy <= 14; dy++) {
    if (y + dy >= HEIGHT) break;
    let nextStemX = -1;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = curX + dx;
      const ny = y + dy;
      if (!world.inBounds(nx, ny)) continue;
      const m = world.type[world.idx(nx, ny)];
      if (m === Mat.WetSoil || m === Mat.Water) return true;
      if (m === Mat.PlantStem) nextStemX = nx;
    }
    if (nextStemX === -1) break;
    curX = nextStemX;
  }
  return false;
}
