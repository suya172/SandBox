/**
 * 決定論的疑似乱数生成器 (Mulberry32) と座標ハッシュ関数
 * シード共有および再現性のあるテスト・プロシージャル表現に使用する
 */
export class PRNG {
  private state: number;

  constructor(seed: number = 123456789) {
    this.state = seed >>> 0 || 1;
  }

  /** 現在の内部状態を取得 */
  getState(): number {
    return this.state >>> 0;
  }

  /** 内部状態を復元 */
  setState(state: number): void {
    this.state = state >>> 0 || 1;
  }

  /** 0以上1未満の浮動小数点乱数を返す */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 0以上 max 未満の整数乱数を返す */
  nextInt(max: number): number {
    return (this.next() * max) | 0;
  }

  /** min 以上 max 以下の整数乱数を返す */
  rangeInt(min: number, max: number): number {
    return min + ((this.next() * (max - min + 1)) | 0);
  }

  /** 確率 p (0.0 ~ 1.0) で true を返す */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * 2D座標とシードから決定論的な 0..255 のノイズ値を高速算出する（GCフリー）
 */
export function hash2D(x: number, y: number, seed: number = 0): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) & 0xff;
}

