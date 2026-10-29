import { describe, expect, it } from 'vitest';
import { Mat } from '../src/core/materials';
import { stepSimulation } from '../src/core/simulation';
import { generateTerrain } from '../src/core/terrainGen';
import { HEIGHT, WIDTH, WorldGrid } from '../src/core/world';

describe('Phase 1: Core Cellular Automata & Elemental Chemistry', () => {
  it('砂が重力で落下して床の上に堆積し、水中では水と入れ替わって沈むこと', () => {
    const world = new WorldGrid(101);
    // 床を作る
    for (let x = 10; x <= 20; x++) {
      world.setCell(x, 50, Mat.Stone);
    }
    // 水たまりを作る
    world.setCell(15, 49, Mat.Water);
    // 上空に砂を置く
    world.setCell(15, 45, Mat.Sand);

    for (let t = 0; t < 20; t++) {
      stepSimulation(world);
    }

    // 砂は水より重いため底 (y=49) に沈み、水は上または横へ押し出される
    expect(world.getMat(15, 49)).toBe(Mat.Sand);
  });

  it('水 + 溶岩 で「黒曜石」と「蒸気」が創発生成されること', () => {
    const world = new WorldGrid(202);
    for (let x = 28; x <= 34; x++) {
      world.setCell(x, 62, Mat.Stone);
    }
    world.setCell(30, 61, Mat.Magma);
    world.setCell(30, 60, Mat.Water);

    for (let t = 0; t < 8; t++) {
      stepSimulation(world);
    }

    let hasObsidian = false;
    let hasSteamOrCondensedWater = false;
    for (let y = 45; y <= 61; y++) {
      for (let x = 26; x <= 36; x++) {
        const m = world.getMat(x, y);
        if (m === Mat.Obsidian) hasObsidian = true;
        if (m === Mat.Steam) hasSteamOrCondensedWater = true;
      }
    }

    expect(hasObsidian).toBe(true);
    expect(hasSteamOrCondensedWater).toBe(true);
  });

  it('蒸気が上昇し、冷たい天井または上空低温域で再び「水」に凝結する水循環が動作すること', () => {
    const world = new WorldGrid(303);
    // 上空 y=12 にガラス天井を設置
    for (let x = 40; x <= 60; x++) {
      world.setCell(x, 12, Mat.Glass, 0, 15);
    }
    world.setCell(50, 20, Mat.Steam, 40, 90);

    for (let t = 0; t < 120; t++) {
      stepSimulation(world);
    }

    let waterCount = 0;
    for (let y = 13; y < HEIGHT; y++) {
      for (let x = 35; x <= 65; x++) {
        if (world.getMat(x, y) === Mat.Water) waterCount++;
      }
    }
    expect(waterCount).toBeGreaterThan(0);
  });

  it('砂が高熱（雷または溶岩）を受けると「ガラス」へ変化すること', () => {
    const world = new WorldGrid(404);
    world.setCell(80, 81, Mat.Stone);
    world.setCell(80, 80, Mat.Sand, 0, 650);

    stepSimulation(world);
    expect(world.getMat(80, 80)).toBe(Mat.Glass);
  });

  it('乾いた土が水で「湿潤土」になり、種が発芽して茎・葉・花・蜜や果実へ成長すること', () => {
    const world = new WorldGrid(505);
    for (let x = 95; x <= 105; x++) {
      world.setCell(x, 100, Mat.Stone);
      world.setCell(x, 99, Mat.Soil);
    }
    // 水を与えて湿潤土にする
    world.setCell(100, 98, Mat.Water);
    for (let t = 0; t < 15; t++) {
      stepSimulation(world);
    }
    expect(world.getMat(100, 99)).toBe(Mat.WetSoil);

    // 湿潤土の上に種を蒔く
    world.setCell(100, 98, Mat.Seed);
    for (let t = 0; t < 600; t++) {
      stepSimulation(world);
    }

    let stemOrLeafCount = 0;
    for (let y = 80; y <= 98; y++) {
      for (let x = 96; x <= 104; x++) {
        const m = world.getMat(x, y);
        if (m === Mat.PlantStem || m === Mat.Leaf || m === Mat.Flower) {
          stemOrLeafCount++;
        }
      }
    }
    expect(stemOrLeafCount).toBeGreaterThan(2);
  });

  it('シード地形生成が決定論的であり、Alchemist Mode では中央に保護付きテラリウム・コアが生成されること', () => {
    const w1 = new WorldGrid();
    const w2 = new WorldGrid();
    generateTerrain(w1, 'alchemist', 77777);
    generateTerrain(w2, 'alchemist', 77777);

    expect(w1.hasCore).toBe(true);
    expect(w1.getMat(w1.coreX, w1.coreY)).toBe(Mat.Core);
    // 同じシードなら完全に同一の配列が生成される
    expect(w1.type).toEqual(w2.type);
    expect(WIDTH).toBe(256);
    expect(HEIGHT).toBe(144);
  });
});
