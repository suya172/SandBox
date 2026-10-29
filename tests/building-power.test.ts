import { describe, expect, it } from 'vitest';
import { BgMat, Mat } from '../src/core/materials';
import { stepSimulation } from '../src/core/simulation';
import { generateTerrain } from '../src/core/terrainGen';
import { WorldGrid } from '../src/core/world';
import { LightingRenderer } from '../src/render/lighting';
import { WorldRenderer } from '../src/render/renderer';
import { stepProceduralDecor } from '../src/systems/building';
import { stepPowerAndMachines } from '../src/systems/power';
import { applyBrush } from '../src/ui/viewport';

describe('Phase 2: Procedural Cozy Building & Power / Logic Grid', () => {
  it('谷をまたいで木材を引くと太鼓橋アーチと背景支柱が自動生成され、裏側を水が通過できること', () => {
    const world = new WorldGrid(1001);
    // 谷の底と左右の岸を作る
    for (let x = 20; x <= 40; x++) {
      world.setCell(x, 80, Mat.Stone);
    }
    world.setCell(24, 74, Mat.Stone);
    world.setCell(36, 74, Mat.Stone);

    // 谷をまたぐように木材をドラッグ配置 (x=25..35, y=74)
    for (let x = 25; x <= 35; x++) {
      applyBrush(world, x, 74, 0, Mat.Wood, false);
    }

    // x=30 (5の倍数) の下方に木製支柱 BgMat.WoodPillar が生成されていること
    expect(world.bgType[world.idx(30, 75)]).toBe(BgMat.WoodArch);
    expect(world.bgType[world.idx(30, 77)]).toBe(BgMat.WoodPillar);

    // 支柱がある x=30 の前景は Air のままなので、左に壁を置いて流した水が支柱の裏側を通過して右側に溜まること
    for (let y = 75; y <= 79; y++) {
      world.setCell(26, y, Mat.Stone);
      world.setCell(39, y, Mat.Stone);
      world.setCell(27, y, Mat.Water);
      world.setCell(28, y, Mat.Water);
      world.setCell(29, y, Mat.Water);
    }
    for (let t = 0; t < 25; t++) {
      stepSimulation(world);
    }

    let waterRightOfPillar = 0;
    for (let x = 31; x <= 38; x++) {
      for (let y = 76; y <= 79; y++) {
        if (world.getMat(x, y) === Mat.Water) waterRightOfPillar++;
      }
    }
    expect(waterRightOfPillar).toBeGreaterThan(0);
  });

  it('木材十字構造の中心に銅を置くと「羽根車」へ創発変化し、蒸気・水流で発電して銅線先のゲートを開くこと', () => {
    const world = new WorldGrid(2002);
    const cx = 60;
    const cy = 60;

    // 木材の十字構造を作る
    applyBrush(world, cx - 1, cy, 0, Mat.Wood, false);
    applyBrush(world, cx + 1, cy, 0, Mat.Wood, false);
    applyBrush(world, cx, cy - 1, 0, Mat.Wood, false);
    applyBrush(world, cx, cy + 1, 0, Mat.Wood, false);

    // 中心に銅を置く → 自動的に RotorHub へ変化し、周囲に RotorBlade 背景が展開される
    applyBrush(world, cx, cy, 0, Mat.Copper, false);
    expect(world.getMat(cx, cy)).toBe(Mat.RotorHub);
    expect(world.bgType[world.idx(cx + 1, cy)]).toBe(BgMat.RotorBlade);

    // 右へ銅線を伸ばし、先端に自動ゲート (GateClosed) を接続
    for (let x = cx + 1; x <= cx + 6; x++) {
      world.setCell(x, cy, Mat.Copper);
    }
    world.setCell(cx + 7, cy, Mat.GateClosed);

    // 羽根車の下から蒸気を当てて回転・発電させる
    world.setCell(cx, cy + 1, Mat.Steam, 120, 115);
    world.setCell(cx - 1, cy + 1, Mat.Steam, 120, 115);

    for (let t = 0; t < 6; t++) {
      stepPowerAndMachines(world);
    }

    expect(world.charge[world.idx(cx, cy)]).toBeGreaterThan(60);
    expect(world.charge[world.idx(cx + 6, cy)]).toBeGreaterThan(45);
    expect(world.getMat(cx + 7, cy)).toBe(Mat.GateOpen);
  });

  it('環境センサーが水を検知して信号を出し、電動ポンプがパイプ経由で水を圧送吐出すること', () => {
    const world = new WorldGrid(3003);
    // 水槽とポンプ・パイプ・センサーを設置
    world.setCell(99, 91, Mat.Water);
    world.setCell(100, 91, Mat.Water);
    world.setCell(100, 90, Mat.Pump);
    world.setCell(98, 90, Mat.Sensor); // (99,91) の水を検知
    world.setCell(99, 90, Mat.Copper); // センサーからポンプへ給電

    // ポンプの上から右へパイプを繋ぐ
    world.setCell(100, 89, Mat.Pipe);
    world.setCell(101, 89, Mat.Pipe);
    world.setCell(102, 89, Mat.Pipe);

    for (let t = 0; t < 4; t++) {
      stepPowerAndMachines(world);
    }

    // パイプの出口周辺 (x>=102) に水が圧送されていること
    let pumped = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (world.getMat(102 + dx, 89 + dy) === Mat.Water) {
          pumped = true;
        }
      }
    }
    expect(pumped).toBe(true);
  });

  it('湿潤環境にある石ブロックに時間経過で苔装飾 (bgMeta >= 101) が発生すること', () => {
    const world = new WorldGrid(4004);
    for (let y = 40; y < 80; y++) {
      for (let x = 40; x < 80; x++) {
        world.setCell(x, y, (x + y) % 2 === 0 ? Mat.Stone : Mat.Water);
      }
    }
    for (let t = 0; t < 150; t++) {
      stepProceduralDecor(world);
    }
    let mossyCount = 0;
    for (let y = 40; y < 80; y++) {
      for (let x = 40; x < 80; x++) {
        if (world.bgMeta[world.idx(x, y)] >= 101) mossyCount++;
      }
    }
    expect(mossyCount).toBeGreaterThan(0);
  });

  it('WorldRenderer と LightingRenderer が全セルと発光グローを破綻なく計算できること', () => {
    const world = new WorldGrid();
    generateTerrain(world, 'alchemist', 4242);
    world.timeOfDay = 0.05; // 夜間
    world.setCell(90, 70, Mat.Magma);
    world.setCell(92, 70, Mat.Mushroom);

    const renderer = new WorldRenderer(true);
    const lighting = new LightingRenderer(true);
    renderer.renderToBuffer(world, renderer.pixels32, true);
    lighting.updateGlowMap(world, [{ x: 100, y: 70, r: 255, g: 220, b: 100 }]);

    // 全ピクセルが不透明アルファ (0xFF000000) を持ち、グローバッファに光が拡散していること
    expect((renderer.pixels32[0] >>> 24) & 0xff).toBe(255);
    let maxGlow = 0;
    for (let i = 0; i < lighting.bufR.length; i++) {
      if (lighting.bufR[i] > maxGlow) maxGlow = lighting.bufR[i];
    }
    expect(maxGlow).toBeGreaterThan(10);
  });
});
