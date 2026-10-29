import { describe, expect, it } from 'vitest';
import { Mat } from '../src/core/materials';
import { generateTerrain } from '../src/core/terrainGen';
import { WorldGrid } from '../src/core/world';
import { SpriteManager } from '../src/entities/sprites';
import { ProgressionManager } from '../src/modes/alchemist';
import { Storyteller } from '../src/modes/storyteller';
import { BlueprintManager } from '../src/ugc/blueprint';
import { crc32, embedWorldIntoPng, extractWorldFromPng } from '../src/ugc/pngStego';
import { deserializeWorld, serializeWorld } from '../src/ugc/serializer';

/** テスト用の最小有効 PNG バイナリ (IHDR + IDAT + IEND) を構築 */
function makeMinimalPng(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const makeChunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    const typeBytes = [
      type.charCodeAt(0),
      type.charCodeAt(1),
      type.charCodeAt(2),
      type.charCodeAt(3),
    ];
    const crcInput = new Uint8Array([...typeBytes, ...data]);
    const c = crc32(crcInput);
    return [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...typeBytes,
      ...data,
      (c >>> 24) & 0xff,
      (c >>> 16) & 0xff,
      (c >>> 8) & 0xff,
      c & 0xff,
    ];
  };

  const ihdr = makeChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = makeChunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]);
  const iend = makeChunk('IEND', []);
  return new Uint8Array([...sig, ...ihdr, ...idat, ...iend]);
}

describe('Phase 4: Alchemist Progression, Mother Nature & Serverless UGC', () => {
  it('Alchemist Mode の全5段階納品ラダーが順番に解放され、二次生成物は直接ブラシ配置できないこと', () => {
    const prog = new ProgressionManager();
    prog.reset('alchemist');

    // 初期状態では Seed / Copper / WeatherAntenna は未解放、二次生成物 Nectar も不可
    expect(prog.isBrushUnlocked(Mat.Water)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Seed)).toBe(false);
    expect(prog.isBrushUnlocked(Mat.Nectar)).toBe(false);

    // Stage 1: 水 100滴納品 → Seed, Wood, Glass 解放
    prog.recordDelivery('water', 100);
    expect(prog.stage).toBe(2);
    expect(prog.isBrushUnlocked(Mat.Seed)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Wood)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Glass)).toBe(true);

    // Stage 2: 蜜 20 + 果実 20 納品 → Copper, VoltFern, RotorHub 解放
    prog.recordDelivery('nectar', 20);
    prog.recordDelivery('fruit', 20);
    expect(prog.stage).toBe(3);
    expect(prog.isBrushUnlocked(Mat.Copper)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.RotorHub)).toBe(true);

    // Stage 3: 電力 400W 納品 → Magma, Pipe, Pump, Battery 解放
    prog.recordDelivery('power', 400);
    expect(prog.stage).toBe(4);
    expect(prog.isBrushUnlocked(Mat.Pump)).toBe(true);

    // Stage 4: 黒曜石 15 + 電力 250W → GateClosed, Sensor, Lightning 解放
    prog.recordDelivery('obsidian', 15);
    prog.recordDelivery('power', 250);
    expect(prog.stage).toBe(5);
    expect(prog.isBrushUnlocked(Mat.Sensor)).toBe(true);

    // Stage 5: 星のかけら 8個 → WeatherAntenna 解放 & 全ステージ達成 (stage=6)
    prog.recordDelivery('star_shard', 8);
    expect(prog.stage).toBe(6);
    expect(prog.isBrushUnlocked(Mat.WeatherAntenna)).toBe(true);
    // それでも二次生成物（蜜・黒曜石・星のかけら）は Alchemist Mode では直接ブラシ出し不可
    expect(prog.isBrushUnlocked(Mat.Nectar)).toBe(false);
    expect(prog.isBrushUnlocked(Mat.StarShard)).toBe(false);
  });

  it('Mother Nature の気象イベント（梅雨・熱波・星屑の夜）がワールドへ物理変化を与えること', () => {
    const world = new WorldGrid(6100);
    const sprites = new SpriteManager();
    const prog = new ProgressionManager();
    prog.reset('alchemist');
    const st = new Storyteller();

    // 星屑の夜を発動すると上空に StarShard が生成されること
    st.triggerWeather('starfall', 300);
    for (let i = 0; i < 120; i++) {
      world.tick++;
      st.update(world, sprites, prog);
    }
    let shards = 0;
    for (let i = 0; i < world.type.length; i++) {
      if (world.type[i] === Mat.StarShard) shards++;
    }
    expect(shards).toBeGreaterThan(0);

    // 熱波を発動すると ambientTempOffset が上昇すること
    st.triggerWeather('heatwave', 200);
    for (let i = 0; i < 60; i++) {
      world.tick++;
      st.update(world, sprites, prog);
    }
    expect(world.ambientTempOffset).toBeGreaterThan(0);
  });

  it('RLE + Base64 シリアライズと PNG tEXt チャンク埋め込みでワールドが完全一致復元されること', () => {
    const srcWorld = new WorldGrid();
    const srcProg = new ProgressionManager();
    srcProg.reset('alchemist');
    generateTerrain(srcWorld, 'alchemist', 987654);
    srcProg.recordDelivery('water', 100); // Stage 2 へ進める
    srcWorld.setCell(80, 40, Mat.Glass);
    srcWorld.setCell(81, 40, Mat.Copper);

    const code = serializeWorld(srcWorld, srcProg);
    expect(code.length).toBeGreaterThan(50);
    expect(code.length).toBeLessThan(20000); // RLE により十分コンパクトであること

    // PNG バイナリへ埋め込み → 抽出
    const rawPng = makeMinimalPng();
    const embeddedPng = embedWorldIntoPng(rawPng, code);
    const extractedCode = extractWorldFromPng(embeddedPng);
    expect(extractedCode).toBe(code);

    // 別インスタンスへデシリアライズして完全一致を確認
    const dstWorld = new WorldGrid();
    const dstProg = new ProgressionManager();
    const ok = deserializeWorld(extractedCode!, dstWorld, dstProg);

    expect(ok).toBe(true);
    expect(dstProg.mode).toBe('alchemist');
    expect(dstProg.stage).toBe(2);
    expect(dstWorld.seed).toBe(987654);
    expect(dstWorld.type).toEqual(srcWorld.type);
    expect(dstWorld.bgType).toEqual(srcWorld.bgType);
  });

  it('ブループリントの範囲キャプチャと別座標へのスタンプ配置が正しく機能すること', () => {
    const world = new WorldGrid(7700);
    const prog = new ProgressionManager();
    prog.reset('cozy');
    const bpMgr = new BlueprintManager();

    world.setCell(20, 20, Mat.Glass);
    world.setCell(21, 20, Mat.Glass);
    world.setCell(20, 21, Mat.Wood);
    world.setCell(21, 21, Mat.Wood);

    const bp = bpMgr.captureRegion(world, 20, 20, 21, 21, 'TestBox');
    expect(bp).not.toBeNull();
    expect(bp!.width).toBe(2);
    expect(bp!.height).toBe(2);

    const placed = bpMgr.stamp(world, bp!, 60, 60, prog);
    expect(placed).toBe(4);
    expect(world.getMat(59, 59)).toBe(Mat.Glass);
    expect(world.getMat(60, 60)).toBe(Mat.Wood);
  });
});

