import { describe, expect, it } from 'vitest';
import { Mat } from '../src/core/materials';
import { placeTerrariumCore } from '../src/core/terrainGen';
import { WorldGrid } from '../src/core/world';
import { SpriteManager } from '../src/entities/sprites';

describe('Phase 3: Autonomous Sprites Ecosystem & Automation FSM', () => {
  it('モフみず (Aqua-Puff) が水を吸い込み、近くの炎 (Fire) へ運んで消火すること', () => {
    const world = new WorldGrid(5100);
    for (let x = 20; x <= 60; x++) {
      world.setCell(x, 80, Mat.Stone);
    }
    // 水たまり (x=30) と 火災 (x=42)
    world.setCell(30, 79, Mat.Water);
    world.setCell(42, 79, Mat.Fire, 120, 520);

    const mgr = new SpriteManager();
    const puff = mgr.spawn('aqua_puff', 30, 78)!;
    expect(puff).not.toBeNull();

    for (let t = 0; t < 80; t++) {
      mgr.update(world);
    }

    // 炎が消火されて蒸気または空気に変わっていること
    expect(world.getMat(42, 79)).not.toBe(Mat.Fire);
  });

  it('コロねっこ (Root-Roller) が落ちた果実を拾い、テラリウム・コアへ運搬して納品すること', () => {
    const world = new WorldGrid(5200);
    for (let x = 80; x <= 145; x++) {
      world.setCell(x, 90, Mat.Stone);
    }
    placeTerrariumCore(world, 128, 87);

    let deliveredFruit = 0;
    world.onCoreDeliver = (kind, amount) => {
      if (kind === 'fruit') deliveredFruit += amount;
    };

    // コアから少し離れた地面に果実を配置
    world.setCell(108, 89, Mat.Fruit, 100);

    const mgr = new SpriteManager();
    mgr.spawn('root_roller', 107, 89);

    for (let t = 0; t < 120; t++) {
      mgr.update(world);
    }

    expect(deliveredFruit).toBeGreaterThanOrEqual(1);
    expect(world.getMat(108, 89)).toBe(Mat.Air);
  });

  it('ピカリん (Spark-Bit) が帯電した発電シダから電気を受け取り、未通電ポンプへ給電すること', () => {
    const world = new WorldGrid(5300);
    world.setCell(50, 60, Mat.VoltFern);
    world.charge[world.idx(50, 60)] = 200;

    world.setCell(62, 60, Mat.Pump);
    world.charge[world.idx(62, 60)] = 0;

    const mgr = new SpriteManager();
    mgr.spawn('spark_bit', 50, 59);

    for (let t = 0; t < 140; t++) {
      mgr.update(world);
      if (world.charge[world.idx(62, 60)] >= 150) break;
    }

    expect(world.charge[world.idx(62, 60)]).toBeGreaterThanOrEqual(150);
  });

  it('夜行性のカゲむし (Shade-Mite) が無防備なコアに到達すると Vitality を削り、帯電銅線に触れると撃退され資源を落とすこと', () => {
    const world = new WorldGrid(5400);
    world.timeOfDay = 0.05; // 深夜
    for (let x = 90; x <= 160; x++) {
      world.setCell(x, 90, Mat.Stone);
    }
    placeTerrariumCore(world, 128, 87);
    world.updateLightField();

    const mgr = new SpriteManager();
    // 1. 無防備なコア近傍（台座手前の地上）にカゲむしを配置 → コアへ歩いて到達し耐久が減少すること
    mgr.spawn('shade_mite', 121, 89);
    for (let t = 0; t < 90; t++) {
      mgr.update(world);
    }
    expect(world.coreVitality).toBeLessThan(100);

    // 2. 帯電した銅線フェンス (charge=180) を設置してカゲむしを歩かせる → 感電撃退され Ash または StarShard がドロップすること
    mgr.clearMites();
    world.setCell(105, 89, Mat.Copper);
    world.charge[world.idx(105, 89)] = 180;
    mgr.spawn('shade_mite', 105, 88);
    mgr.update(world);

    expect(mgr.countByKind().shade_mite).toBe(0);
    let droppedResource = false;
    for (let y = 87; y <= 89; y++) {
      for (let x = 104; x <= 106; x++) {
        const m = world.getMat(x, y);
        if (m === Mat.Ash || m === Mat.StarShard) droppedResource = true;
      }
    }
    expect(droppedResource).toBe(true);
  });

  it('カゲむしが強い光源（発光キノコ群）に照らされ続けると光忌避・浄化消散すること', () => {
    const world = new WorldGrid(5500);
    world.timeOfDay = 0.05; // 深夜
    for (let x = 30; x <= 60; x++) {
      world.setCell(x, 80, Mat.Stone);
    }
    // 両端を石壁で囲んだ発光キノコ防衛帯を敷設し、継続照射による浄化消散を検証
    for (let y = 76; y <= 79; y++) {
      world.setCell(35, y, Mat.Stone);
      world.setCell(53, y, Mat.Stone);
    }
    for (const mx of [38, 42, 46, 50]) {
      world.setCell(mx, 79, Mat.Mushroom);
    }
    world.updateLightField();

    const mgr = new SpriteManager();
    mgr.spawn('shade_mite', 45, 79);

    for (let t = 0; t < 45; t++) {
      mgr.update(world);
    }
    expect(mgr.countByKind().shade_mite).toBe(0);
  });
});

