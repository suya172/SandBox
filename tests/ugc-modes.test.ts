import { describe, expect, it } from 'vitest';
import { Mat } from '../src/core/materials';
import { stepSimulation } from '../src/core/simulation';
import { generateTerrain } from '../src/core/terrainGen';
import { WorldGrid } from '../src/core/world';
import { SpriteManager } from '../src/entities/sprites';
import { ProgressionManager } from '../src/modes/alchemist';
import { Storyteller } from '../src/modes/storyteller';
import { BlueprintManager } from '../src/ugc/blueprint';
import { crc32, embedWorldIntoPng, extractWorldFromPng } from '../src/ugc/pngStego';
import { deserializeWorld, serializeWorld } from '../src/ugc/serializer';
import { applyHybridBrush } from '../src/ui/viewport';

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

describe('Phase 4: Alchemist 2.0 Hybrid Progression, Nocturnal Raids & Serverless UGC', () => {
  it('Alchemist Mode の4段階ツールティアが段階的に解放され、二次生成物は直接配置できないこと', () => {
    const prog = new ProgressionManager();
    prog.reset('alchemist');

    // Tier 1 初期状態: Water/Soil/Wood/Seed/Fire は使用可、Stone/Copper/WeatherAntenna や二次生成物 Nectar は不可
    expect(prog.toolTier).toBe(1);
    expect(prog.isBrushUnlocked(Mat.Water)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Wood)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Stone)).toBe(false);
    expect(prog.isBrushUnlocked(Mat.Copper)).toBe(false);
    expect(prog.isBrushUnlocked(Mat.Nectar)).toBe(false);

    // Tier 1 → Tier 2: 水・有機物納品 40（または Day 2 到達）で Stone, Glass, Mushroom 解放
    prog.recordDelivery('water', 40, 1);
    expect(prog.toolTier).toBe(2);
    expect(prog.isBrushUnlocked(Mat.Stone)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Glass)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Mushroom)).toBe(true);

    // Tier 2 → Tier 3: 地下の銅鉱石 6個採取＋水/有機物納品 50 で電化・配管ツール一式が解放
    for (let i = 0; i < 6; i++) {
      prog.harvestCell(Mat.Copper, 2);
    }
    prog.recordDelivery('fruit', 10, 2);
    expect(prog.toolTier).toBe(3);
    expect(prog.isBrushUnlocked(Mat.Copper)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Pump)).toBe(true);
    expect(prog.isBrushUnlocked(Mat.Sensor)).toBe(true);

    // Tier 3 → Tier 4: 黒曜石 10 + 星のかけら 6 で WeatherAntenna 解放 & 全解放ブラシ INF 化
    prog.recordDelivery('obsidian', 10, 8);
    prog.recordDelivery('star_shard', 6, 8);
    expect(prog.toolTier).toBe(4);
    expect(prog.isBrushUnlocked(Mat.WeatherAntenna)).toBe(true);
    expect(prog.getEffectiveStock(Mat.Copper).infinite).toBe(true);

    // 二次生成物（蜜・黒曜石・星のかけら）は Tier 4 でも直接ブラシ配置不可
    expect(prog.isBrushUnlocked(Mat.Nectar)).toBe(false);
    expect(prog.isBrushUnlocked(Mat.StarShard)).toBe(false);
  });

  it('ハイブリッド操作：硬度ロック判定・吸引採取ストック加算・配置消費・湧水開通による INF 化が機能すること', () => {
    const world = new WorldGrid(6050);
    const prog = new ProgressionManager();
    prog.reset('alchemist');

    // 硬岩 (HardStone, H=2) と 土 (Soil, H=1) を配置
    world.setCell(40, 60, Mat.HardStone);
    world.setCell(42, 60, Mat.Soil);

    // Tier 1 で硬岩を吸引しようとすると blockedTier=2 が返り掘削できない
    const blockedRes = applyHybridBrush(world, prog, 40, 60, 0, Mat.Air, 'harvest');
    expect(blockedRes.changedCount).toBe(0);
    expect(blockedRes.blockedTier).toBe(2);
    expect(world.getMat(40, 60)).toBe(Mat.HardStone);

    // 土 (H=1) は Tier 1 でも吸引でき、Soil ストックが +1 増える
    const soilBefore = prog.stock[Mat.Soil];
    const digSoilRes = applyHybridBrush(world, prog, 42, 60, 0, Mat.Air, 'harvest');
    expect(digSoilRes.changedCount).toBe(1);
    expect(prog.stock[Mat.Soil]).toBe(soilBefore + 1);

    // 配置するとストックが 1 消費される
    const placeSoilRes = applyHybridBrush(world, prog, 44, 60, 0, Mat.Soil, 'place');
    expect(placeSoilRes.changedCount).toBe(1);
    expect(prog.stock[Mat.Soil]).toBe(soilBefore);

    // Tier 2 へ昇格すると HardStone が掘削可能になり、Stone ストックへ回収される
    prog.checkTierPromotion(2);
    expect(prog.toolTier).toBe(2);
    const stoneBefore = prog.stock[Mat.Stone];
    const digHardRes = applyHybridBrush(world, prog, 40, 60, 0, Mat.Air, 'harvest');
    expect(digHardRes.changedCount).toBe(1);
    expect(world.getMat(40, 60)).toBe(Mat.Air);
    expect(prog.stock[Mat.Stone]).toBe(stoneBefore + 1);

    // 稼働中の湧水石 (Spring, meta=0) が存在すると Water が無限供給 (INF) になること
    expect(prog.getEffectiveStock(Mat.Water).infinite).toBe(false);
    world.setCell(50, 70, Mat.Spring, 0);
    prog.evaluateInfrastructure(world);
    expect(prog.getEffectiveStock(Mat.Water).infinite).toBe(true);
  });

  it('夜間襲撃エスカレーションおよび全滅時の「直前の朝からリトライ」スナップショット復元が動作すること', () => {
    const world = new WorldGrid(6100);
    const sprites = new SpriteManager();
    const prog = new ProgressionManager();
    prog.reset('alchemist');
    generateTerrain(world, 'alchemist', 6100);
    prog.saveDawnState();
    const st = new Storyteller();

    // 朝時点の状態を記憶
    const dawnWoodStock = prog.stock[Mat.Wood];
    expect(world.coreVitality).toBe(100);

    // 資源を使い、夜にして襲撃を発生させ、コアを全滅 (Vitality=0) させる
    prog.stock[Mat.Wood] = 0;
    world.setCell(128, 40, Mat.Glass);
    world.timeOfDay = 0.85; // 夜へ移行
    world.tick = 150;
    st.update(world, sprites, prog);
    expect(st.nightQuota).toBeGreaterThanOrEqual(3);
    expect(st.nightQuota).toBeLessThanOrEqual(5); // Day 1 は少数出現

    world.damageCore(100);
    expect(world.coreVitality).toBe(0);

    // 直前の朝スナップショットから巻き戻し
    expect(world.restoreDawnSnapshot()).toBe(true);
    expect(prog.restoreDawnState()).toBe(true);
    expect(world.coreVitality).toBe(100);
    expect(prog.stock[Mat.Wood]).toBe(dawnWoodStock);
    expect(world.getMat(128, 40)).toBe(Mat.Air);

    // 気象イベント（星屑の夜・熱波）も引き続き機能すること
    st.triggerWeather('starfall', 300);
    for (let i = 0; i < 120; i++) {
      stepSimulation(world);
      st.update(world, sprites, prog);
    }
    let shards = 0;
    for (let i = 0; i < world.type.length; i++) {
      if (world.type[i] === Mat.StarShard) shards++;
    }
    expect(shards).toBeGreaterThan(0);
  });

  it('RLE + Base64 V2 シリアライズと PNG tEXt チャンク埋め込みでワールド・ストック・ティアが完全復元されること', () => {
    const srcWorld = new WorldGrid();
    const srcProg = new ProgressionManager();
    srcProg.reset('alchemist');
    generateTerrain(srcWorld, 'alchemist', 987654);
    srcProg.recordDelivery('water', 40, 2); // Tier 2
    srcProg.stock[Mat.Copper] = 17;
    srcProg.infiniteMask[Mat.Water] = 1;
    srcWorld.coreVitality = 84;
    srcWorld.setCell(80, 40, Mat.Glass);
    srcWorld.setCell(81, 40, Mat.Copper);

    const code = serializeWorld(srcWorld, srcProg);
    expect(code.length).toBeGreaterThan(50);
    expect(code.length).toBeLessThan(24000);

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
    expect(dstProg.toolTier).toBe(2);
    expect(dstProg.stock[Mat.Copper]).toBe(17);
    expect(dstProg.infiniteMask[Mat.Water]).toBe(1);
    expect(dstWorld.coreVitality).toBe(84);
    expect(dstWorld.seed).toBe(987654);
    expect(dstWorld.type).toEqual(srcWorld.type);
    expect(dstWorld.bgType).toEqual(srcWorld.bgType);
  });

  it('ブループリントの範囲キャプチャとスタンプ配置（Cozy 無制限 & Alchemist ストック連動）が機能すること', () => {
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
