import { BgMat, MAT_CONDUCTIVE, Mat, MatId } from '../core/materials';
import { HEIGHT, SIZE, WIDTH, WorldGrid } from '../core/world';

/** 事前確保した電位計算用一時バッファ（GCゼロ） */
const nextChargeBuf = new Uint8Array(SIZE);
const bfsVisited = new Uint8Array(SIZE);
const bfsQueue = new Int32Array(512);

const DX4 = [0, 1, 0, -1];
const DY4 = [-1, 0, 1, 0];

const DX8 = [0, 1, 1, 1, 0, -1, -1, -1];
const DY8 = [-1, -1, 0, 1, 1, 1, 0, -1];

/**
 * 電気回路・羽根車発電・センサー・自動ゲート・電動ポンプ＆パイプシステム (Phase 2 & 4)
 */
export function stepPowerAndMachines(world: WorldGrid): void {
  nextChargeBuf.fill(0);

  // 1. 発電素子・センサー・蓄電池・羽根車の更新と初期電位セット
  for (let y = 0; y < HEIGHT; y++) {
    const row = y << 8;
    for (let x = 0; x < WIDTH; x++) {
      const i = row + x;
      const mat = world.type[i] as MatId;
      const curCharge = world.charge[i];

      if (mat === Mat.RotorHub) {
        const gen = updateRotorHub(world, x, y, i);
        nextChargeBuf[i] = Math.max(curCharge > 8 ? curCharge - 8 : 0, gen);
      } else if (mat === Mat.Sensor) {
        const active = evaluateSensor(world, x, y);
        nextChargeBuf[i] = active ? 220 : 0;
      } else if (mat === Mat.Battery) {
        // 周囲から高い電荷が来ていれば蓄電 (meta: 0..250)、低ければ放電
        const maxNeighbor = getMaxNeighborCharge(world, x, y);
        let stored = world.meta[i];
        if (maxNeighbor > 130 && stored < 250) {
          stored = Math.min(250, stored + 3);
          world.meta[i] = stored;
          nextChargeBuf[i] = maxNeighbor - 10;
        } else if (stored > 0) {
          if ((world.tick & 3) === 0) {
            stored--;
            world.meta[i] = stored;
          }
          nextChargeBuf[i] = 175;
        }
      } else if (mat === Mat.VoltFern) {
        // 蒸気や雷で帯電した電荷を緩やかに減衰させながら放出
        nextChargeBuf[i] = curCharge > 4 ? curCharge - 4 : 0;
      } else if (MAT_CONDUCTIVE[mat] === 1 && curCharge > 0) {
        // 銅線等の減衰ベース
        nextChargeBuf[i] = curCharge > 12 ? curCharge - 12 : 0;
      }
    }
  }

  // 2. 銅線・導電ネットワークへの高速伝播（1フレームに3ステップ伝播させて長距離回路も快適に通電）
  for (let pass = 0; pass < 3; pass++) {
    world.charge.set(nextChargeBuf);
    for (let y = 0; y < HEIGHT; y++) {
      const row = y << 8;
      for (let x = 0; x < WIDTH; x++) {
        const i = row + x;
        const mat = world.type[i];
        if (MAT_CONDUCTIVE[mat] === 0) continue;
        // 水や湿潤土は大きく減衰させ、銅線は低損失で伝える
        const drop = mat === Mat.Copper || mat === Mat.Core ? 6 : 28;
        let best = world.charge[i];

        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d];
          const ny = y + DY8[d];
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
          // 斜め接続は銅線同士のみ許可
          if ((d & 1) === 1 && mat !== Mat.Copper) continue;
          const ni = (ny << 8) + nx;
          const nCharge = world.charge[ni];
          if (nCharge - drop > best) {
            best = nCharge - drop;
          }
        }
        nextChargeBuf[i] = best;
      }
    }
  }
  world.charge.set(nextChargeBuf);

  // 3. アクチュエータ（自動ゲート開閉・電動ポンプ圧送・パイプ吐出・コア電力納品）の駆動
  let corePowerDeliveredThisFrame = 0;

  for (let y = 0; y < HEIGHT; y++) {
    const row = y << 8;
    for (let x = 0; x < WIDTH; x++) {
      const i = row + x;
      const mat = world.type[i] as MatId;
      const ch = world.charge[i];

      if (mat === Mat.GateClosed) {
        if (ch >= 45 || getMaxNeighborCharge(world, x, y) >= 45) {
          world.type[i] = Mat.GateOpen;
          world.wakeAround(x, y);
        }
      } else if (mat === Mat.GateOpen) {
        if (ch < 30 && getMaxNeighborCharge(world, x, y) < 30) {
          world.type[i] = Mat.GateClosed;
          world.wakeAround(x, y);
        }
      } else if (mat === Mat.Pump) {
        if (ch >= 45 && (world.tick & 1) === 0) {
          runElectricPump(world, x, y);
        }
      } else if (mat === Mat.Core) {
        // コアに直接繋がる銅線に電流が流れている場合、電力を納品計上
        if (ch >= 50 && (world.tick & 3) === 0 && corePowerDeliveredThisFrame === 0) {
          for (let d = 0; d < 4; d++) {
            const nx = x + DX4[d];
            const ny = y + DY4[d];
            if (!world.inBounds(nx, ny)) continue;
            const ni = world.idx(nx, ny);
            if (world.type[ni] === Mat.Copper && world.charge[ni] >= 55) {
              corePowerDeliveredThisFrame = Math.max(1, (world.charge[ni] / 45) | 0);
              break;
            }
          }
        }
      }
    }
  }

  if (corePowerDeliveredThisFrame > 0) {
    world.onCoreDeliver?.('power', corePowerDeliveredThisFrame);
  }
}

/**
 * 羽根車（水車・風車）の周囲を通過する水・蒸気を検知して回転させ、発電量を返す
 */
function updateRotorHub(world: WorldGrid, cx: number, cy: number, hubIdx: number): number {
  let kinetic = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      const m = world.type[world.idx(gx, gy)];
      if (m === Mat.Water || m === Mat.Steam || m === Mat.Nectar) {
        kinetic++;
      }
    }
  }

  // meta を回転運動量・角度カウンタとして利用
  let momentum = world.meta[hubIdx];
  if (kinetic > 0) {
    momentum = Math.min(240, momentum + kinetic * 6);
  } else if (momentum > 0) {
    momentum = Math.max(0, momentum - 2);
  }
  world.meta[hubIdx] = momentum;

  if (momentum > 0) {
    const phase = ((world.tick * ((momentum >> 5) + 1)) >> 2) & 3;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0 || dx * dx + dy * dy > 5) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (!world.inBounds(gx, gy)) continue;
        const bi = world.idx(gx, gy);
        if (world.bgType[bi] === BgMat.RotorBlade) {
          world.bgMeta[bi] = phase;
        }
      }
    }
    return Math.min(230, 60 + momentum);
  }

  return 0;
}

/**
 * 環境センサー：周囲2マス以内に流体（水・蒸気・蜜）または高温（≥80℃）があれば ON になる
 */
function evaluateSensor(world: WorldGrid, cx: number, cy: number): boolean {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;
      const i = world.idx(gx, gy);
      const m = world.type[i];
      if (m === Mat.Water || m === Mat.Steam || m === Mat.Nectar || world.temp[i] >= 80) {
        return true;
      }
    }
  }
  return false;
}

function getMaxNeighborCharge(world: WorldGrid, x: number, y: number): number {
  let max = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX4[d];
    const ny = y + DY4[d];
    if (!world.inBounds(nx, ny)) continue;
    const ch = world.charge[world.idx(nx, ny)];
    if (ch > max) max = ch;
  }
  return max;
}

/**
 * 電動ポンプ：下または横の液体を吸い込み、接続された Pipe 網の出口（または真上）へ圧送吐出する
 */
function runElectricPump(world: WorldGrid, px: number, py: number): void {
  // 1. 吸水元を探す（下 → 左 → 右）
  const intakes: [number, number][] = [
    [px, py + 1],
    [px - 1, py],
    [px + 1, py],
    [px - 1, py + 1],
    [px + 1, py + 1],
  ];

  let srcX = -1;
  let srcY = -1;
  let fluidMat: MatId = Mat.Air;
  let fluidTemp = 20;

  for (const [ix, iy] of intakes) {
    if (!world.inBounds(ix, iy)) continue;
    const m = world.getMat(ix, iy);
    if (m === Mat.Water || m === Mat.Nectar || m === Mat.Magma) {
      srcX = ix;
      srcY = iy;
      fluidMat = m;
      fluidTemp = world.temp[world.idx(ix, iy)];
      break;
    }
  }

  if (fluidMat === Mat.Air) return;

  // 2. 隣接する Pipe があれば BFS でパイプ終端を探し、そこへ吐出（または Core へ直接納品）
  let hasPipe = false;
  for (let d = 0; d < 4; d++) {
    const nx = px + DX4[d];
    const ny = py + DY4[d];
    if (world.inBounds(nx, ny) && world.getMat(nx, ny) === Mat.Pipe) {
      hasPipe = true;
      break;
    }
  }

  if (hasPipe) {
    bfsVisited.fill(0);
    let head = 0;
    let tail = 0;

    for (let d = 0; d < 4; d++) {
      const nx = px + DX4[d];
      const ny = py + DY4[d];
      if (!world.inBounds(nx, ny)) continue;
      const ni = world.idx(nx, ny);
      if (world.type[ni] === Mat.Pipe && tail < bfsQueue.length) {
        bfsVisited[ni] = 1;
        bfsQueue[tail++] = ni;
      }
    }

    let bestOutX = -1;
    let bestOutY = -1;

    while (head < tail) {
      const cur = bfsQueue[head++];
      world.pipeFluid[cur] = fluidMat;
      const cx = cur & 0xff;
      const cy = cur >> 8;

      let nextPipeCount = 0;
      let touchesPump = false;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX4[d];
        const ny = cy + DY4[d];
        if (!world.inBounds(nx, ny)) continue;
        if (nx === px && ny === py) touchesPump = true;
        const ni = world.idx(nx, ny);
        if (world.type[ni] === Mat.Pipe) {
          nextPipeCount++;
          if (bfsVisited[ni] === 0 && tail < bfsQueue.length) {
            bfsVisited[ni] = 1;
            bfsQueue[tail++] = ni;
          }
        } else if (world.type[ni] === Mat.Core && (fluidMat === Mat.Water || fluidMat === Mat.Nectar)) {
          // パイプがテラリウム・コアに直結している場合は直接納品！
          world.setCell(srcX, srcY, Mat.Air);
          world.onCoreDeliver?.(fluidMat === Mat.Water ? 'water' : 'nectar', 1);
          return;
        }
      }

      // ポンプから離れたパイプ端点（または単一パイプ）の開口部を出口候補として更新（BFS終端優先）
      if (nextPipeCount <= 1 && (!touchesPump || nextPipeCount === 0)) {
        for (let d = 0; d < 4; d++) {
          const ox = cx + DX4[d];
          const oy = cy + DY4[d];
          if ((ox === srcX && oy === srcY) || (ox === px && oy === py)) continue;
          if (world.inBounds(ox, oy) && world.type[world.idx(ox, oy)] === Mat.Air) {
            bestOutX = ox;
            bestOutY = oy;
            break;
          }
        }
      }
    }

    if (bestOutX !== -1) {
      world.setCell(srcX, srcY, Mat.Air);
      world.setCell(bestOutX, bestOutY, fluidMat, 0, fluidTemp);
    }
    return;
  }

  // 3. パイプがない場合はポンプの真上 (y-1, y-2) に汲み上げる
  for (let dy = 1; dy <= 2; dy++) {
    if (world.inBounds(px, py - dy) && world.getMat(px, py - dy) === Mat.Air) {
      world.setCell(srcX, srcY, Mat.Air);
      world.setCell(px, py - dy, fluidMat, 0, fluidTemp);
      return;
    }
  }
}
