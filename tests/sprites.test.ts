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
});

