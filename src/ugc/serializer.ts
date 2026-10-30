import { MAT_COUNT, MAT_DEFAULT_TEMP } from '../core/materials';
import { GameMode } from '../core/terrainGen';
import { SIZE, WorldGrid } from '../core/world';
import { ProgressionManager, ToolTier } from '../modes/alchemist';

const MAGIC_T = 0x54; // 'T'
const VERSION_V1 = 1;
const VERSION_V2 = 2;

/**
 * サーバーレスUGC共有用 RLE (ランレングス圧縮) + URL-safe Base64 シリアライザ
 * V2: ワールド全プレーンに加え、ツールティア・コア耐久値・採取ストック・無限化マスクを可逆保存する
 * V1: 既存の共有コードもエラーなく復元できる後方互換デコーダを保持
 */
export function serializeWorld(world: WorldGrid, progression: ProgressionManager): string {
  const bytes: number[] = [];

  // V2 ヘッダ (16 bytes)
  bytes.push(MAGIC_T, VERSION_V2);
  pushUint32(bytes, world.seed);
  bytes.push(progression.mode === 'alchemist' ? 1 : 0);
  bytes.push(progression.toolTier & 0xff);
  bytes.push(progression.raidsEnabled ? 1 : 0);
  bytes.push(Math.max(0, Math.min(255, world.coreVitality | 0)));
  pushUint16(bytes, Math.round(world.timeOfDay * 10000));
  pushUint16(bytes, world.dayCount & 0xffff);
  bytes.push(world.hasCore ? 1 : 0);
  bytes.push(world.coreX & 0xff);
  bytes.push(world.coreY & 0xff);

  // Alchemist 進行統計 (7 * 2 = 14 bytes)
  pushUint16(bytes, Math.min(65535, progression.stats.waterDelivered));
  pushUint16(bytes, Math.min(65535, progression.stats.bioDelivered));
  pushUint16(bytes, Math.min(65535, progression.stats.powerDelivered));
  pushUint16(bytes, Math.min(65535, progression.stats.glassCollected));
  pushUint16(bytes, Math.min(65535, progression.stats.copperCollected));
  pushUint16(bytes, Math.min(65535, progression.stats.obsidianCollected));
  pushUint16(bytes, Math.min(65535, progression.stats.starShardCollected));

  // 無限化マスク (MAT_COUNT bytes)
  bytes.push(MAT_COUNT);
  for (let m = 0; m < MAT_COUNT; m++) {
    bytes.push(progression.infiniteMask[m] ? 1 : 0);
  }

  // 非ゼロ所持ストックのスパース格納 ([count, (matId, amountU16)...])
  const nonZeroStocks: [number, number][] = [];
  if (progression.mode === 'alchemist') {
    for (let m = 0; m < MAT_COUNT; m++) {
      const amt = progression.stock[m];
      if (amt > 0) {
        nonZeroStocks.push([m, Math.min(65535, amt)]);
      }
    }
  }
  bytes.push(nonZeroStocks.length & 0xff);
  for (const [m, amt] of nonZeroStocks) {
    bytes.push(m & 0xff);
    pushUint16(bytes, amt);
  }

  // 各プレーンを RLE 圧縮して格納
  encodeRLEPlane(bytes, world.type);
  encodeRLEPlane(bytes, world.meta);
  encodeRLEPlane(bytes, world.flags);
  encodeRLEPlane(bytes, world.bgType);
  encodeRLEPlane(bytes, world.bgMeta);
  encodeRLEPlane(bytes, world.charge);

  // 温度は量子化 (-60 ~ +960℃ を 4℃ 刻みで 0..255 に丸め) して RLE 圧縮
  const quantTemp = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const q = Math.max(0, Math.min(255, Math.round((world.temp[i] + 60) / 4)));
    quantTemp[i] = q;
  }
  encodeRLEPlane(bytes, quantTemp);

  return bytesToUrlBase64(new Uint8Array(bytes));
}

/**
 * URL-safe Base64 文字列からワールド状態と進行状況を復元する（V1 / V2 両対応）
 */
export function deserializeWorld(
  code: string,
  world: WorldGrid,
  progression: ProgressionManager
): boolean {
  try {
    const clean = code.trim().replace(/^#?world=/, '');
    if (!clean) return false;
    const data = urlBase64ToBytes(clean);
    if (data.length < 25 || data[0] !== MAGIC_T) {
      return false;
    }

    const version = data[1];
    if (version !== VERSION_V1 && version !== VERSION_V2) {
      return false;
    }

    let offset = 2;
    const readU32 = () => {
      const v =
        ((data[offset] << 24) |
          (data[offset + 1] << 16) |
          (data[offset + 2] << 8) |
          data[offset + 3]) >>>
        0;
      offset += 4;
      return v;
    };
    const readU16 = () => {
      const v = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return v;
    };

    const seed = readU32();
    const mode: GameMode = data[offset++] === 1 ? 'alchemist' : 'cozy';
    const tierOrStage = data[offset++];

    let raidsEnabled = true;
    let coreVitality = 100;
    if (version === VERSION_V2) {
      raidsEnabled = data[offset++] === 1;
      coreVitality = data[offset++];
    }

    const timeScaled = readU16();
    const dayCount = readU16();
    const hasCore = data[offset++] === 1;
    const coreX = data[offset++];
    const coreY = data[offset++];

    world.clear();
    world.seed = seed;
    world.timeOfDay = Math.max(0, Math.min(0.9999, timeScaled / 10000));
    world.dayCount = Math.max(1, dayCount);
    world.hasCore = hasCore;
    world.coreX = coreX;
    world.coreY = coreY;
    world.coreVitality = Math.max(1, Math.min(world.maxCoreVitality, coreVitality));

    progression.reset(mode);

    if (version === VERSION_V1) {
      // V1 後方互換：旧 stage (1..6) を ToolTier (1..4) へマッピング
      const mappedTier = Math.max(1, Math.min(4, tierOrStage >= 5 ? 4 : tierOrStage)) as ToolTier;
      progression.toolTier = mode === 'cozy' ? 4 : mappedTier;
      progression.stats.waterDelivered = readU16();
      progression.stats.bioDelivered = readU16();
      progression.stats.powerDelivered = readU16();
      progression.stats.obsidianCollected = readU16();
      progression.stats.starShardCollected = readU16();
    } else {
      progression.toolTier = (
        mode === 'cozy' ? 4 : Math.max(1, Math.min(4, tierOrStage))
      ) as ToolTier;
      progression.raidsEnabled = raidsEnabled;
      progression.stats.waterDelivered = readU16();
      progression.stats.bioDelivered = readU16();
      progression.stats.powerDelivered = readU16();
      progression.stats.glassCollected = readU16();
      progression.stats.copperCollected = readU16();
      progression.stats.obsidianCollected = readU16();
      progression.stats.starShardCollected = readU16();

      const maskLen = data[offset++];
      progression.infiniteMask.fill(0);
      for (let m = 0; m < maskLen; m++) {
        const flag = data[offset++];
        if (m < progression.infiniteMask.length) {
          progression.infiniteMask[m] = flag ? 1 : 0;
        }
      }

      const stockCount = data[offset++];
      if (mode === 'alchemist') {
        progression.stock.fill(0);
      }
      for (let k = 0; k < stockCount; k++) {
        const m = data[offset++];
        const amt = readU16();
        if (m < progression.stock.length) {
          progression.stock[m] = amt;
        }
      }
    }

    offset = decodeRLEPlane(data, offset, world.type);
    offset = decodeRLEPlane(data, offset, world.meta);
    offset = decodeRLEPlane(data, offset, world.flags);
    offset = decodeRLEPlane(data, offset, world.bgType);
    offset = decodeRLEPlane(data, offset, world.bgMeta);
    offset = decodeRLEPlane(data, offset, world.charge);

    const quantTemp = new Uint8Array(SIZE);
    decodeRLEPlane(data, offset, quantTemp);
    for (let i = 0; i < SIZE; i++) {
      const m = world.type[i];
      const t = quantTemp[i] * 4 - 60;
      const defT = m < MAT_COUNT ? MAT_DEFAULT_TEMP[m] : 22;
      world.temp[i] = Math.abs(t - defT) <= 2 ? defT : t;
    }

    world.saveDawnSnapshot();
    progression.saveDawnState();
    world.updateLightField();
    world.wakeAll();
    return true;
  } catch {
    return false;
  }
}

function encodeRLEPlane(out: number[], plane: Uint8Array): void {
  let i = 0;
  const len = plane.length;
  while (i < len) {
    const val = plane[i];
    let run = 1;
    while (i + run < len && plane[i + run] === val && run < 16383) {
      run++;
    }
    if (run === 1 && val < 0xc0) {
      out.push(val);
    } else {
      out.push(0xc0 | ((run >> 8) & 0x3f), run & 0xff, val);
    }
    i += run;
  }
}

function decodeRLEPlane(src: Uint8Array, startOffset: number, target: Uint8Array): number {
  let offset = startOffset;
  let outIdx = 0;
  const len = target.length;

  while (outIdx < len && offset < src.length) {
    const b0 = src[offset++];
    if ((b0 & 0xc0) === 0xc0) {
      const b1 = src[offset++];
      const val = src[offset++];
      const run = ((b0 & 0x3f) << 8) | b1;
      const end = Math.min(len, outIdx + run);
      target.fill(val, outIdx, end);
      outIdx = end;
    } else {
      target[outIdx++] = b0;
    }
  }
  return offset;
}

function pushUint32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function pushUint16(out: number[], v: number): void {
  out.push((v >>> 8) & 0xff, v & 0xff);
}

export function bytesToUrlBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function urlBase64ToBytes(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
