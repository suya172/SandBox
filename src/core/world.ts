import { BgMat, BgMatId, MATERIALS, MAT_DEFAULT_TEMP, Mat, MatId } from './materials';
import { PRNG } from './prng';

export const WIDTH = 256;
export const HEIGHT = 144;
export const SIZE = WIDTH * HEIGHT; // 36,864

export const CHUNK_SIZE = 16;
export const CHUNK_SHIFT = 4; // 2^4 = 16
export const CHUNKS_X = WIDTH >> CHUNK_SHIFT;  // 16
export const CHUNKS_Y = HEIGHT >> CHUNK_SHIFT; // 9
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y; // 144

export const LIGHT_W = WIDTH >> 2;  // 64
export const LIGHT_H = HEIGHT >> 2; // 36
export const LIGHT_SIZE = LIGHT_W * LIGHT_H; // 2,304

/** セルフラグビット定義 */
export const FLAG_UPDATED = 1 << 0;         // 現フレームで移動済み
export const FLAG_INDESTRUCTIBLE = 1 << 1;  // 破壊不可（コア本体・ベッドロックなど）
export const FLAG_NO_BRUSH = 1 << 2;        // Alchemist Mode での直接ブラシ描画保護エリア
export const FLAG_RUIN = 1 << 3;            // 古代遺構ブロック（Tier 3以上で回収・再配置可、接続利用は常時可）

/** 日の出時点のゼロコスト・リトライ用スナップショット構造体 */
interface DawnSnapshot {
  valid: boolean;
  type: Uint8Array;
  temp: Int16Array;
  meta: Uint8Array;
  charge: Uint8Array;
  flags: Uint8Array;
  bgType: Uint8Array;
  bgMeta: Uint8Array;
  pipeFluid: Uint8Array;
  tick: number;
  timeOfDay: number;
  dayCount: number;
  coreVitality: number;
  rngState: number;
}

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

  // パイプ内部輸送バッファ（Pipe セルが保持している液体ID）
  readonly pipeFluid = new Uint8Array(SIZE);

  // 64x36 低解像度輝度マップ（カゲむしの O(1) 光忌避ナビゲーションおよび瘴気消散判定で共有）
  readonly lightLuma = new Uint8Array(LIGHT_SIZE);
  private readonly lightTmp = new Uint16Array(LIGHT_SIZE);

  // 直前の朝からのリトライ用事前確保バッファ（約 260 KB）
  private readonly dawnSnap: DawnSnapshot = {
    valid: false,
    type: new Uint8Array(SIZE),
    temp: new Int16Array(SIZE),
    meta: new Uint8Array(SIZE),
    charge: new Uint8Array(SIZE),
    flags: new Uint8Array(SIZE),
    bgType: new Uint8Array(SIZE),
    bgMeta: new Uint8Array(SIZE),
    pipeFluid: new Uint8Array(SIZE),
    tick: 0,
    timeOfDay: 0.25,
    dayCount: 1,
    coreVitality: 100,
    rngState: 1,
  };

  // ワールドメタ情報
  seed: number;
  rng: PRNG;
  tick: number = 0;
  timeOfDay: number = 0.3; // 0.0=深夜, 0.25=朝, 0.5=正午, 0.75=夕方
  dayCount: number = 1;
  ambientTempOffset: number = 0; // 熱波などの気象補正

  // テラリウム・コア中心座標および耐久値（Alchemist Mode）
  coreX: number = WIDTH >> 1;
  coreY: number = 82;
  hasCore: boolean = false;
  coreVitality: number = 100;
  readonly maxCoreVitality: number = 100;

  // イベントコールバック
  onCoreDeliver?: (
    kind: 'water' | 'nectar' | 'fruit' | 'power' | 'obsidian' | 'star_shard',
    amount: number
  ) => void;
  onCoreDamaged?: (damage: number, remainingVitality: number) => void;
  onDawn?: (dayCount: number) => void;

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
    this.lightLuma.fill(0);
    this.chunkActive.fill(1);
    this.chunkNextActive.fill(1);
    this.tick = 0;
    this.timeOfDay = 0.3;
    this.dayCount = 1;
    this.ambientTempOffset = 0;
    this.hasCore = false;
    this.coreVitality = this.maxCoreVitality;
    this.dawnSnap.valid = false;
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

  /** 指定セル座標における局所光源輝度 (0..255) を O(1) 取得 */
  getLightAt(x: number, y: number): number {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return 0;
    return this.lightLuma[(y >> 2) * LIGHT_W + (x >> 2)];
  }

  /** コアへダメージを与え、0 になった場合はクランプして通知する */
  damageCore(amount: number): void {
    if (!this.hasCore || amount <= 0 || this.coreVitality <= 0) return;
    this.coreVitality = Math.max(0, this.coreVitality - amount);
    this.onCoreDamaged?.(amount, this.coreVitality);
  }

  /** コアの耐久値を回復する（水・蜜・電力納品時などの微回復） */
  healCore(amount: number): void {
    if (!this.hasCore || amount <= 0 || this.coreVitality <= 0) return;
    this.coreVitality = Math.min(this.maxCoreVitality, this.coreVitality + amount);
  }

  /** 日の出時点のワールド状態を事前確保バッファへ高速コピー保存（< 0.1ms） */
  saveDawnSnapshot(): void {
    const s = this.dawnSnap;
    s.type.set(this.type);
    s.temp.set(this.temp);
    s.meta.set(this.meta);
    s.charge.set(this.charge);
    s.flags.set(this.flags);
    s.bgType.set(this.bgType);
    s.bgMeta.set(this.bgMeta);
    s.pipeFluid.set(this.pipeFluid);
    s.tick = this.tick;
    s.timeOfDay = this.timeOfDay;
    s.dayCount = this.dayCount;
    s.coreVitality = Math.max(25, this.coreVitality);
    s.rngState = this.rng.getState();
    s.valid = true;
  }

  /** 保存済みの朝スナップショットからワールド状態を即座に巻き戻す */
  restoreDawnSnapshot(): boolean {
    const s = this.dawnSnap;
    if (!s.valid) return false;
    this.type.set(s.type);
    this.temp.set(s.temp);
    this.meta.set(s.meta);
    this.charge.set(s.charge);
    this.flags.set(s.flags);
    this.bgType.set(s.bgType);
    this.bgMeta.set(s.bgMeta);
    this.pipeFluid.set(s.pipeFluid);
    this.tick = s.tick;
    this.timeOfDay = s.timeOfDay;
    this.dayCount = s.dayCount;
    this.coreVitality = s.coreVitality;
    this.ambientTempOffset = 0;
    this.rng.setState(s.rngState);
    this.wakeAll();
    return true;
  }

  hasDawnSnapshot(): boolean {
    return this.dawnSnap.valid;
  }

  /**
   * ヘッドレス環境（単体テスト等）でも呼び出せる軽量輝度マップ更新
   * 発光セル・帯電セル・追加光源を集計し、1パスのボックス拡散で 64x36 輝度場を作る
   */
  updateLightField(
    extraLights?: ReadonlyArray<{ x: number; y: number; r: number; g: number; b: number }>
  ): void {
    this.lightTmp.fill(0);
    const types = this.type;
    const charges = this.charge;

    for (let ly = 0; ly < LIGHT_H; ly++) {
      const baseY = ly << 2;
      for (let lx = 0; lx < LIGHT_W; lx++) {
        const baseX = lx << 2;
        let lumaSum = 0;
        for (let dy = 0; dy < 4; dy++) {
          const row = (baseY + dy) << 8;
          for (let dx = 0; dx < 4; dx++) {
            const idx = row + baseX + dx;
            const mat = types[idx];
            if (mat !== Mat.Air && mat !== Mat.Core) {
              const glow = MATERIALS[mat].glowColor;
              if (glow) {
                const maxG = glow[0] > glow[1] ? (glow[0] > glow[2] ? glow[0] : glow[2]) : (glow[1] > glow[2] ? glow[1] : glow[2]);
                lumaSum += maxG;
              }
              const ch = charges[idx];
              if (ch > 20) lumaSum += ch >> 1;
            }
          }
        }
        if (lumaSum > 0) {
          this.lightTmp[ly * LIGHT_W + lx] = Math.min(255, (lumaSum * 0.55) | 0);
        }
      }
    }

    if (extraLights) {
      for (let k = 0; k < extraLights.length; k++) {
        const l = extraLights[k];
        const lx = l.x >> 2;
        const ly = l.y >> 2;
        if (lx >= 0 && lx < LIGHT_W && ly >= 0 && ly < LIGHT_H) {
          const li = ly * LIGHT_W + lx;
          const m = Math.max(l.r, l.g, l.b);
          this.lightTmp[li] = Math.min(255, this.lightTmp[li] + m);
        }
      }
    }

    // 3x3 近傍拡散で周囲ブロックへ光の反発圏を広げる
    for (let y = 0; y < LIGHT_H; y++) {
      const ym1 = (y > 0 ? y - 1 : y) * LIGHT_W;
      const y0 = y * LIGHT_W;
      const yp1 = (y < LIGHT_H - 1 ? y + 1 : y) * LIGHT_W;
      for (let x = 0; x < LIGHT_W; x++) {
        const xm1 = x > 0 ? x - 1 : x;
        const xp1 = x < LIGHT_W - 1 ? x + 1 : x;
        const center = this.lightTmp[y0 + x];
        const neighbors =
          this.lightTmp[y0 + xm1] +
          this.lightTmp[y0 + xp1] +
          this.lightTmp[ym1 + x] +
          this.lightTmp[yp1 + x];
        this.lightLuma[y0 + x] = Math.min(255, Math.max(center, (center * 2 + neighbors) >> 2));
      }
    }
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

  /** 現在の太陽高度による明るさ係数 (0.16 ~ 1.0) を取得 */
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
