/**
 * PNG `tEXt` チャンクへのロスレス・ワールドデータ埋め込み＆抽出 (Phase 4)
 * 保存したスナップショットPNG画像をドラッグ＆ドロップするだけで箱庭を完全復元できる
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_KEYWORD = 'TerraWeave';

/** IEEE 802.3 CRC32 テーブルの事前計算 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * PNG バイナリの `IEND` チャンク直前に `tEXt` チャンクとしてワールドコードを埋め込む
 */
export function embedWorldIntoPng(pngBytes: Uint8Array, worldCode: string): Uint8Array {
  if (!isValidPngSignature(pngBytes)) {
    throw new Error('Invalid PNG binary signature');
  }

  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(CHUNK_KEYWORD);
  const valBytes = encoder.encode(worldCode);
  const dataLen = keyBytes.length + 1 + valBytes.length; // keyword + null separator + text

  // チャンク構造: Length(4) + Type('tEXt', 4) + Data(dataLen) + CRC(4)
  const chunkTotal = 12 + dataLen;
  const chunk = new Uint8Array(chunkTotal);

  // Length (Big-Endian)
  chunk[0] = (dataLen >>> 24) & 0xff;
  chunk[1] = (dataLen >>> 16) & 0xff;
  chunk[2] = (dataLen >>> 8) & 0xff;
  chunk[3] = dataLen & 0xff;

  // Type: 'tEXt'
  chunk[4] = 0x74; // t
  chunk[5] = 0x45; // E
  chunk[6] = 0x58; // X
  chunk[7] = 0x74; // t

  // Data: Keyword + 0x00 + Payload
  chunk.set(keyBytes, 8);
  chunk[8 + keyBytes.length] = 0x00;
  chunk.set(valBytes, 8 + keyBytes.length + 1);

  // CRC32 (Type + Data)
  const crcVal = crc32(chunk.subarray(4, 8 + dataLen));
  const crcPos = 8 + dataLen;
  chunk[crcPos] = (crcVal >>> 24) & 0xff;
  chunk[crcPos + 1] = (crcVal >>> 16) & 0xff;
  chunk[crcPos + 2] = (crcVal >>> 8) & 0xff;
  chunk[crcPos + 3] = crcVal & 0xff;

  // IEND チャンクの位置を走査してその直前に挿入
  let iendOffset = -1;
  let pos = 8;
  while (pos + 8 <= pngBytes.length) {
    const len = readUint32BE(pngBytes, pos);
    const typeStr = String.fromCharCode(
      pngBytes[pos + 4],
      pngBytes[pos + 5],
      pngBytes[pos + 6],
      pngBytes[pos + 7]
    );
    if (typeStr === 'IEND') {
      iendOffset = pos;
      break;
    }
    pos += 12 + len;
  }

  if (iendOffset === -1) {
    throw new Error('PNG IEND chunk not found');
  }

  const out = new Uint8Array(pngBytes.length + chunkTotal);
  out.set(pngBytes.subarray(0, iendOffset), 0);
  out.set(chunk, iendOffset);
  out.set(pngBytes.subarray(iendOffset), iendOffset + chunkTotal);
  return out;
}

/**
 * PNG バイナリから埋め込まれた `TerraWeave` ワールドコードを抽出・CRC検証して返す
 */
export function extractWorldFromPng(pngBytes: Uint8Array): string | null {
  if (!isValidPngSignature(pngBytes)) return null;

  const decoder = new TextDecoder();
  let pos = 8;

  while (pos + 12 <= pngBytes.length) {
    const len = readUint32BE(pngBytes, pos);
    if (pos + 12 + len > pngBytes.length) break;

    const typeStr = String.fromCharCode(
      pngBytes[pos + 4],
      pngBytes[pos + 5],
      pngBytes[pos + 6],
      pngBytes[pos + 7]
    );

    if (typeStr === 'tEXt') {
      const typeAndData = pngBytes.subarray(pos + 4, pos + 8 + len);
      const expectedCrc = readUint32BE(pngBytes, pos + 8 + len);
      if (crc32(typeAndData) === expectedCrc) {
        const dataSlice = pngBytes.subarray(pos + 8, pos + 8 + len);
        const nullIdx = dataSlice.indexOf(0);
        if (nullIdx > 0) {
          const keyword = decoder.decode(dataSlice.subarray(0, nullIdx));
          if (keyword === CHUNK_KEYWORD) {
            return decoder.decode(dataSlice.subarray(nullIdx + 1));
          }
        }
      }
    }

    if (typeStr === 'IEND') break;
    pos += 12 + len;
  }

  return null;
}

function isValidPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 20) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function readUint32BE(bytes: Uint8Array, pos: number): number {
  return (
    ((bytes[pos] << 24) |
      (bytes[pos + 1] << 16) |
      (bytes[pos + 2] << 8) |
      bytes[pos + 3]) >>>
    0
  );
}

