import { MAT_DEFAULT_TEMP } from '../core/materials';
import { GameMode } from '../core/terrainGen';
import { SIZE, WorldGrid } from '../core/world';
import { ProgressionManager } from '../modes/alchemist';

const MAGIC_V1 = 0x54; // 'T'
const VERSION = 1;

/**
 * サーバーレスUGC共有用 RLE (ランレングス圧縮) + URL-safe Base64 シリアライザ (Phase 4)
 * ワールド状態・モード・進行状況を単一のコンパクトなテキストコードへ可逆変換する
 */
export function serializeWorld(world: WorldGrid, progression: ProgressionManager): string {
  const bytes: number[] = [];

  // ヘッダ (14 bytes)
  bytes.push(MAGIC_V1, VERSION);
  pushUint32(bytes, world.seed);
  bytes.push(progression.mode === 'alchemist' ? 1 : 0);
  bytes.push(progression.stage & 0xff);
  pushUint16(bytes, Math.round(world.timeOfDay * 10000));
  pushUint16(bytes, world.dayCount & 0xffff);
  bytes.push(world.hasCore ? 1 : 0);
  bytes.push(world.coreX & 0xff);
  bytes.push(world.coreY & 0xff);

  // Alchemist 進捗カウンタ (5 * 2 = 10 bytes)
  pushUint16(bytes, progression.progress.water);
  pushUint16(bytes, progression.progress.nectar_or_fruit);
  pushUint16(bytes, progression.progress.power);
  pushUint16(bytes, progression.progress.obsidian);
  pushUint16(bytes, progression.progress.star_shard);

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
 * URL-safe Base64 文字列からワールド状態と進行状況を復元する
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
    if (data.length < 25 || data[0] !== MAGIC_V1 || data[1] !== VERSION) {
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
    const stage = data[offset++];
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

    progression.reset(mode);
    progression.stage = Math.max(1, stage);
    progression.progress.water = readU16();
    progression.progress.nectar_or_fruit = readU16();
    progression.progress.power = readU16();
    progression.progress.obsidian = readU16();
    progression.progress.star_shard = readU16();

    offset = decodeRLEPlane(data, offset, world.type);
    offset = decodeRLEPlane(data, offset, world.meta);
    offset = decodeRLEPlane(data, offset, world.flags);
    offset = decodeRLEPlane(data, offset, world.bgType);
    offset = decodeRLEPlane(data, offset, world.bgMeta);
    offset = decodeRLEPlane(data, offset, world.charge);

    const quantTemp = new Uint8Array(SIZE);
    decodeRLEPlane(data, offset, quantTemp);
    for (let i = 0; i < SIZE; i++) {
      const t = quantTemp[i] * 4 - 60;
      const defT = MAT_DEFAULT_TEMP[world.type[i]];
      world.temp[i] = Math.abs(t - defT) <= 2 ? defT : t;
    }

    world.wakeAll();
    return true;
  } catch {
    return false;
  }
}

/**
 * 1プレーン (36,864 bytes) のランレングス圧縮
 * 同一値が2回以上連続する場合: [0xFF (エスケープ または 上位フラグ)] ではなく
 * ペア形式だと単発値で膨らむため、以下のコンパクト符号を採用:
 * - run === 1 かつ val < 192: [val] (1 byte!)
 * - それ以外: [0xC0 | ((run >> 8) & 0x3F), run & 0xFF, val] (最大 run = 16383, 3 bytes)
 */
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

