import { describe, expect, it } from 'vitest';
import { Mat } from '../src/core/materials';
import { stepSimulation } from '../src/core/simulation';
import { generateTerrain } from '../src/core/terrainGen';
import { FLAG_RUIN, HEIGHT, WIDTH, WorldGrid } from '../src/core/world';

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

    // 5ゾーンバイオーム要素（腐敗土・硬岩・休眠湧水石・深層溶岩・古代遺構フラグ）が含まれること
    let hasBlightSoil = false;
    let hasHardStone = false;
    let hasDormantSpring = false;
    let hasMagma = false;
    let hasRuin = false;
    for (let i = 0; i < w1.size; i++) {
      const m = w1.type[i];
      if (m === Mat.BlightSoil) hasBlightSoil = true;
      if (m === Mat.HardStone) hasHardStone = true;
      if (m === Mat.Spring && w1.meta[i] === 1) hasDormantSpring = true;
      if (m === Mat.Magma) hasMagma = true;
      if ((w1.flags[i] & FLAG_RUIN) !== 0) hasRuin = true;
    }
    expect(hasBlightSoil).toBe(true);
    expect(hasHardStone).toBe(true);
    expect(hasDormantSpring).toBe(true);
    expect(hasMagma).toBe(true);
    expect(hasRuin).toBe(true);
  });

  it('汚染水 (BlightWater) と腐敗土 (BlightSoil) が発光キノコ・灰の作用で清水・湿潤土へ浄化されること', () => {
    const world = new WorldGrid(808);
    for (let x = 38; x <= 45; x++) {
      world.setCell(x, 72, Mat.Stone);
    }
    // 浄化された水が流れ落ちないよう器の両端に縁を設ける
    world.setCell(38, 71, Mat.Stone);
    world.setCell(45, 71, Mat.Stone);
    world.setCell(40, 71, Mat.BlightSoil);
    world.setCell(41, 71, Mat.Mushroom);
    world.setCell(42, 71, Mat.BlightWater);

    for (let t = 0; t < 180; t++) {
      stepSimulation(world);
    }

    expect(world.getMat(40, 71)).toBe(Mat.WetSoil);
    let hasCleanWater = false;
    for (let x = 39; x <= 44; x++) {
      if (world.getMat(x, 71) === Mat.Water) hasCleanWater = true;
    }
    expect(hasCleanWater).toBe(true);
  });

  it('硬岩に封鎖された休眠湧水石 (Spring, meta=1) の周囲を開通させると清水が湧出し始めること', () => {
    const world = new WorldGrid(909);
    // 周囲をすべて硬岩で囲んだ休眠湧水石
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        world.setCell(60 + dx, 90 + dy, Mat.HardStone);
      }
    }
    world.setCell(60, 90, Mat.Spring, 1);

    for (let t = 0; t < 40; t++) {
      stepSimulation(world);
    }
    // 封鎖中は休眠状態 (meta=1) のまま
    expect(world.meta[world.idx(60, 90)]).toBe(1);

    // 上部の硬岩を掘削して空間を開通させる
    world.setCell(60, 89, Mat.Air);
    world.setCell(60, 88, Mat.Air);

    for (let t = 0; t < 60; t++) {
      stepSimulation(world);
    }

    expect(world.meta[world.idx(60, 90)]).toBe(0);
    let spawnedWater = false;
    for (let y = 86; y <= 92; y++) {
      for (let x = 58; x <= 62; x++) {
        if (world.getMat(x, y) === Mat.Water) spawnedWater = true;
      }
    }
    expect(spawnedWater).toBe(true);
  });
});
