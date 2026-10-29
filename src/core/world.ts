import { BgMat, BgMatId, MAT_DEFAULT_TEMP, Mat, MatId } from './materials';
import { PRNG } from './prng';

export const WIDTH = 256;
export const HEIGHT = 144;
export const SIZE = WIDTH * HEIGHT; // 36,864

export const CHUNK_SIZE = 16;
export const CHUNK_SHIFT = 4; // 2^4 = 16
export const CHUNKS_X = WIDTH >> CHUNK_SHIFT;  // 16
export const CHUNKS_Y = HEIGHT >> CHUNK_SHIFT; // 9
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y; // 144

/** セルフラグビット定義 */
export const FLAG_UPDATED = 1 << 0;         // 現フレームで移動済み
export const FLAG_INDESTRUCTIBLE = 1 << 1;  // 破壊不可（コア本体など）
export const FLAG_NO_BRUSH = 1 << 2;        // Alchemist Mode での直接ブラシ描画保護エリア

/**
 * SoA (Structure of Arrays) による二層ワールドグリッド管理クラス
 * GC圧力を避けるため、全状態を固定長 TypedArray で保持する
 */
export class WorldGrid {
  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly size = SIZE;

  // 前景物理レイヤー
  readonly type = new Uint8Array(SIZE);
  readonly temp = new Int16Array(SIZE);
  readonly meta = new Uint8Array(SIZE);
  readonly charge = new Uint8Array(SIZE);
  readonly flags = new Uint8Array(SIZE);

  // 背景構造・装飾レイヤー（太鼓橋アーチ、支柱、羽根車ブレード、苔、コア背景樹）
  readonly bgType = new Uint8Array(SIZE);
  readonly bgMeta = new Uint8Array(SIZE);

  // チャンク休眠管理
  readonly chunkActive = new Uint8Array(CHUNK_COUNT);
  readonly chunkNextActive = new Uint8Array(CHUNK_COUNT);

  // パイプ内部輸送バッファ（Pipe セルが保持している液体IDと量）
  readonly pipeFluid = new Uint8Array(SIZE);

  // ワールドメタ情報
  seed: number;
  rng: PRNG;
  tick: number = 0;
  timeOfDay: number = 0.3; // 0.0=深夜, 0.25=朝, 0.5=正午, 0.75=夕方
  dayCount: number = 1;
  ambientTempOffset: number = 0; // 熱波などの気象補正

  // テラリウム・コア中心座標（Alchemist Mode / コロねっこ納品先）
  coreX: number = WIDTH >> 1;
  coreY: number = 82;
  hasCore: boolean = false;

  // コア納品イベントコールバック（シミュレーション中に納品された要素を通知）
  onCoreDeliver?: (kind: 'water' | 'nectar' | 'fruit' | 'power' | 'obsidian' | 'star_shard', amount: number) => void;

  constructor(seed: number = 20261029) {
    this.seed = seed >>> 0;
    this.rng = new PRNG(this.seed);
    this.clear();
  }

  /** グリッド全体を初期状態（空気・常温）にクリアする */
  clear(): void {
    this.type.fill(Mat.Air);
    this.temp.fill(22);
    this.meta.fill(0);
    this.charge.fill(0);
    this.flags.fill(0);
    this.bgType.fill(BgMat.None);
    this.bgMeta.fill(0);
    this.pipeFluid.fill(Mat.Air);
    this.chunkActive.fill(1);
    this.chunkNextActive.fill(1);
    this.tick = 0;
    this.timeOfDay = 0.3;
    this.dayCount = 1;
    this.ambientTempOffset = 0;
    this.hasCore = false;
  }

  /** 座標がグリッド範囲内か判定 */
  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
  }

  /** 2D座標を一次元インデックスに変換 */
  idx(x: number, y: number): number {
    return (y << 8) + x; // WIDTH === 256 なのでビットシフトで高速計算可能
  }

  /** 指定座標の前景色マテリアルを取得（範囲外は Stone 扱い） */
  getMat(x: number, y: number): MatId {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return Mat.Stone;
    return this.type[(y << 8) + x] as MatId;
  }

  /** 指定座標にマテリアルを配置し、該当・隣接チャンクを起床させる */
  setCell(x: number, y: number, mat: MatId, meta: number = 0, customTemp?: number): void {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const i = (y << 8) + x;
    this.type[i] = mat;
    this.meta[i] = meta;
    this.temp[i] = customTemp !== undefined ? customTemp : MAT_DEFAULT_TEMP[mat];
    this.charge[i] = 0;
    if (mat !== Mat.Pipe) {
      this.pipeFluid[i] = Mat.Air;
    }
    this.wakeAround(x, y);
  }

  /** 背景構造を設定する */
  setBg(x: number, y: number, bg: BgMatId, meta: number = 0): void {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const i = (y << 8) + x;
    this.bgType[i] = bg;
    this.bgMeta[i] = meta;
    this.wakeAround(x, y);
  }

  /** 2つのセルの前景物理データをスワップし、UPDATED フラグを立てる */
  swapCells(i1: number, i2: number): void {
    const tType = this.type[i1];
    const tTemp = this.temp[i1];
    const tMeta = this.meta[i1];
    const tCharge = this.charge[i1];

    this.type[i1] = this.type[i2];
    this.temp[i1] = this.temp[i2];
    this.meta[i1] = this.meta[i2];
    this.charge[i1] = this.charge[i2];

    this.type[i2] = tType;
    this.temp[i2] = tTemp;
    this.meta[i2] = tMeta;
    this.charge[i2] = tCharge;

    this.flags[i1] |= FLAG_UPDATED;
    this.flags[i2] |= FLAG_UPDATED;

    const x1 = i1 & 0xff;
    const y1 = i1 >> 8;
    const x2 = i2 & 0xff;
    const y2 = i2 >> 8;
    this.wakeAround(x1, y1);
    this.wakeAround(x2, y2);
  }

  /** 指定座標を含むチャンクおよび境界隣接チャンクを次フレーム起床予約する */
  wakeAround(x: number, y: number): void {
    const cx = x >> CHUNK_SHIFT;
    const cy = y >> CHUNK_SHIFT;
    this.chunkNextActive[cy * CHUNKS_X + cx] = 1;
    this.chunkActive[cy * CHUNKS_X + cx] = 1;

    const lx = x & 15;
    const ly = y & 15;
    if (lx === 0 && cx > 0) this.chunkNextActive[cy * CHUNKS_X + (cx - 1)] = 1;
    if (lx === 15 && cx < CHUNKS_X - 1) this.chunkNextActive[cy * CHUNKS_X + (cx + 1)] = 1;
    if (ly === 0 && cy > 0) this.chunkNextActive[(cy - 1) * CHUNKS_X + cx] = 1;
    if (ly === 15 && cy < CHUNKS_Y - 1) this.chunkNextActive[(cy + 1) * CHUNKS_X + cx] = 1;
  }

  /** 全チャンクを強制起床させる */
  wakeAll(): void {
    this.chunkActive.fill(1);
    this.chunkNextActive.fill(1);
  }

  /** フレーム開始時の更新フラグクリアとチャンク状態ローテーション */
  beginStep(): void {
    for (let i = 0; i < SIZE; i++) {
      this.flags[i] &= ~FLAG_UPDATED;
    }
    this.chunkActive.set(this.chunkNextActive);
    this.chunkNextActive.fill(0);
  }

  /** 現在の太陽高度による明るさ係数 (0.15 ~ 1.0) を取得 */
  getDaylightFactor(): number {
    // timeOfDay: 0.0=深夜, 0.25=日の出, 0.5=正午, 0.75=日の入り
    const sun = Math.sin((this.timeOfDay - 0.25) * Math.PI * 2);
    return Math.max(0.16, Math.min(1.0, 0.58 + sun * 0.48));
  }

  /** 夜間かどうか判定 */
  isNight(): boolean {
    return this.getDaylightFactor() < 0.42;
  }
}

