import { BgMat, MATERIALS, Mat, packABGR } from '../core/materials';
import { hash2D } from '../core/prng';
import { FLAG_NO_BRUSH, HEIGHT, SIZE, WIDTH, WorldGrid } from '../core/world';

/**
 * Canvas 2D ImageData (Uint32Array) ベースの高速ピクセルレンダラー
 * 昼夜の空グラデーション、背景構造（橋支柱・洞窟壁・古代樹・苔）、前景マテリアルを描画する
 */
export class WorldRenderer {
  readonly offscreen!: HTMLCanvasElement;
  readonly offCtx!: CanvasRenderingContext2D;
  readonly imageData!: ImageData;
  readonly pixels32: Uint32Array;

  // 空グラデーションキャッシュ（高さ144行分）
  private readonly skyColors = new Uint32Array(HEIGHT);

  constructor(headless: boolean = false) {
    if (headless || typeof document === 'undefined') {
      this.pixels32 = new Uint32Array(SIZE);
      return;
    }
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = WIDTH;
    this.offscreen.height = HEIGHT;
    const ctx = this.offscreen.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context initialization failed');
    this.offCtx = ctx;
    this.imageData = ctx.createImageData(WIDTH, HEIGHT);
    this.pixels32 = new Uint32Array(this.imageData.data.buffer);
  }

  /**
   * ワールド状態をオフスクリーンピクセルバッファへ書き込む
   */
  renderPixels(world: WorldGrid, showBrushGuard: boolean = false): void {
    this.renderToBuffer(world, this.pixels32, showBrushGuard);
    this.offCtx.putImageData(this.imageData, 0, 0);
  }

  /**
   * 任意の Uint32Array (SIZE = 256x144) へワールドのABGRピクセルを書き込む（テスト・ヘッドレス検証対応）
   */
  renderToBuffer(
    world: WorldGrid,
    outPixels32: Uint32Array,
    showBrushGuard: boolean = false
  ): void {
    const daylight = world.getDaylightFactor();
    this.computeSkyGradient(world, daylight);

    const types = world.type;
    const metas = world.meta;
    const charges = world.charge;
    const bgTypes = world.bgType;
    const bgMetas = world.bgMeta;
    const pipeFluids = world.pipeFluid;
    const tick = world.tick;

    for (let y = 0; y < HEIGHT; y++) {
      const skyCol = this.skyColors[y];
      const rowOffset = y << 8;

      for (let x = 0; x < WIDTH; x++) {
        const i = rowOffset + x;
        const mat = types[i];
        const h = hash2D(x, y, 42);

        // 1. まず背景色（空 または 背景構造物）を決定
        let bgCol = skyCol;
        const bg = bgTypes[i];
        if (bg !== BgMat.None) {
          bgCol = this.getBackgroundColor(bg, bgMetas[i], x, y, h, daylight, tick);
        } else if (daylight < 0.36 && y < 76 && ((h + x * 17 + y * 31) & 255) === 0) {
          // 夜空に瞬く小さな星々
          const twinkle = ((tick >> 3) + x + y) & 3;
          if (twinkle !== 0) {
            bgCol = packABGR(225, 235, 255);
          }
        }

        if (mat === Mat.Air) {
          if (
            showBrushGuard &&
            (world.flags[i] & FLAG_NO_BRUSH) !== 0 &&
            ((x + y + (tick >> 2)) & 7) === 0
          ) {
            bgCol = blendABGR(bgCol, packABGR(120, 240, 190), 0.22);
          }
          outPixels32[i] = bgCol;
          continue;
        }

        // 2. 前景マテリアルの色計算
        const def = MATERIALS[mat];
        const variantIdx = h % 3;
        let col = def.baseColors[variantIdx];

        if (mat === Mat.Water) {
          // 水面のきらめきと半透明ブレンド
          const shimmer = ((x + (tick >> 2) + y * 3) & 7) === 0;
          if (shimmer || (y > 0 && types[i - WIDTH] === Mat.Air)) {
            col = packABGR(130, 206, 252);
          }
          col = shadeByDaylight(col, Math.max(0.42, daylight));
          outPixels32[i] = blendABGR(bgCol, col, 0.78);
          continue;
        }

        if (mat === Mat.Glass) {
          // ガラスは背景を透かしつつエッジにハイライトを入れる
          const edge = ((x + y) & 3) === 0;
          const glassTint = edge ? packABGR(220, 248, 255) : def.baseColors[1];
          outPixels32[i] = blendABGR(bgCol, shadeByDaylight(glassTint, Math.max(0.55, daylight)), 0.38);
          continue;
        }

        if (mat === Mat.Steam || mat === Mat.Smoke || mat === Mat.Spore) {
          const alpha = mat === Mat.Spore ? 0.82 : 0.48;
          outPixels32[i] = blendABGR(bgCol, col, alpha);
          continue;
        }

        if (mat === Mat.GateOpen) {
          // 開いたゲートは薄いフレームのみ描画
          const border = (x & 1) === 0 && (y & 1) === 0;
          outPixels32[i] = border ? blendABGR(bgCol, col, 0.45) : bgCol;
          continue;
        }

        if (mat === Mat.Pipe) {
          // パイプ内部に流体がある場合は窓のように流体色を見せる
          const innerFluid = pipeFluids[i];
          if (innerFluid !== Mat.Air && ((x + y) & 1) === 0) {
            col = MATERIALS[innerFluid].baseColors[1];
          }
        }

        // 石壁や木材に生えるプロシージャルな苔・ツタ装飾（bgMeta 上位ビット参照）
        if ((mat === Mat.Stone || mat === Mat.Wood) && bgMetas[i] >= 100) {
          const mossLevel = bgMetas[i] - 100;
          if ((h & 7) < mossLevel) {
            col = packABGR(74, 152, 78);
          }
        }

        // 木材の太鼓橋アーチハイライト
        if (mat === Mat.Wood && metas[i] === 2 && y > 0 && types[i - WIDTH] === Mat.Air) {
          col = packABGR(184, 132, 84);
        }

        // 通電中の銅線・発電シダ・バッテリー・センサーの発光表現
        if (charges[i] > 0) {
          const boost = Math.min(1.0, charges[i] / 180);
          col = blendABGR(col, packABGR(255, 244, 132), boost * 0.72);
        } else if (!def.glowColor) {
          // 非発光セルは昼夜の明るさの影響を受ける
          col = shadeByDaylight(col, daylight);
        }

        outPixels32[i] = col;
      }
    }
  }

  private getBackgroundColor(
    bg: number,
    bgMeta: number,
    x: number,
    y: number,
    h: number,
    daylight: number,
    tick: number
  ): number {
    let col: number;
    switch (bg) {
      case BgMat.WoodPillar:
        col = (x & 1) === 0 ? packABGR(98, 66, 42) : packABGR(84, 56, 36);
        break;
      case BgMat.WoodArch:
        col = packABGR(116, 78, 48);
        break;
      case BgMat.StoneWall:
        col = (h & 3) === 0 ? packABGR(44, 48, 58) : packABGR(52, 56, 68);
        if (bgMeta >= 100 && (h & 7) < bgMeta - 100) {
          col = packABGR(46, 98, 62);
        }
        break;
      case BgMat.RotorBlade: {
        // 羽根車の回転ブレードアニメーション（bgMeta に回転角度フェーズが入る）
        const bladeLit = ((bgMeta + x + y) & 3) <= 1;
        col = bladeLit ? packABGR(188, 146, 92) : packABGR(132, 96, 58);
        break;
      }
      case BgMat.CoreTree: {
        if (bgMeta === 2) {
          // 古代樹の神秘的な葉冠
          const pulse = Math.sin(tick * 0.04 + (x + y) * 0.2) > 0.65;
          col = pulse
            ? packABGR(78, 178, 136)
            : (h & 1) === 0
              ? packABGR(46, 118, 86)
              : packABGR(56, 136, 96);
        } else {
          // 古代樹の幹
          col = (x & 1) === 0 ? packABGR(92, 64, 48) : packABGR(78, 54, 40);
        }
        break;
      }
      default:
        col = packABGR(30, 34, 44);
    }
    return shadeByDaylight(col, Math.max(0.28, daylight));
  }

  private computeSkyGradient(world: WorldGrid, daylight: number): void {
    // 朝焼け・夕焼け係数
    const dawnDusk = Math.max(
      0,
      1 - Math.min(Math.abs(world.timeOfDay - 0.25), Math.abs(world.timeOfDay - 0.75)) * 9
    );
    const heatTint = Math.max(0, world.ambientTempOffset / 35);

    const topDay = [42, 82, 142];
    const botDay = [126, 182, 224];
    const topNight = [12, 16, 32];
    const botNight = [24, 32, 58];

    const tFactor = (daylight - 0.16) / 0.84;

    for (let y = 0; y < HEIGHT; y++) {
      const v = y / HEIGHT;
      let r = lerp(lerp(topNight[0], botNight[0], v), lerp(topDay[0], botDay[0], v), tFactor);
      let g = lerp(lerp(topNight[1], botNight[1], v), lerp(topDay[1], botDay[1], v), tFactor);
      let b = lerp(lerp(topNight[2], botNight[2], v), lerp(topDay[2], botDay[2], v), tFactor);

      if (dawnDusk > 0) {
        r += dawnDusk * v * 65;
        g += dawnDusk * v * 22;
        b -= dawnDusk * v * 18;
      }
      if (heatTint > 0) {
        r += heatTint * 42;
        g += heatTint * 12;
        b -= heatTint * 20;
      }

      this.skyColors[y] = packABGR(
        Math.max(0, Math.min(255, r | 0)),
        Math.max(0, Math.min(255, g | 0)),
        Math.max(0, Math.min(255, b | 0))
      );
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** ABGR カラーに明るさ係数を乗算する */
export function shadeByDaylight(abgr: number, factor: number): number {
  const r = ((abgr & 0xff) * factor) | 0;
  const g = (((abgr >>> 8) & 0xff) * factor) | 0;
  const b = (((abgr >>> 16) & 0xff) * factor) | 0;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** 2つの ABGR カラーを alpha (0..1) で線形ブレンドする */
export function blendABGR(dst: number, src: number, alpha: number): number {
  const inv = 1 - alpha;
  const r = ((dst & 0xff) * inv + (src & 0xff) * alpha) | 0;
  const g = (((dst >>> 8) & 0xff) * inv + ((src >>> 8) & 0xff) * alpha) | 0;
  const b = (((dst >>> 16) & 0xff) * inv + ((src >>> 16) & 0xff) * alpha) | 0;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export { SIZE };
