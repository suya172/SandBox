import { MATERIALS, Mat } from '../core/materials';
import { HEIGHT, WIDTH, WorldGrid } from '../core/world';

const LIGHT_W = WIDTH >> 2;  // 64
const LIGHT_H = HEIGHT >> 2; // 36
const LIGHT_SIZE = LIGHT_W * LIGHT_H;

/**
 * 低解像度 (64x36) オフスクリーン・ボックスブラーによるコージー・グローライティング (Phase 2)
 * 溶岩・炎・発光キノコ・星のかけら・通電回路・ピカリん・古代樹コアの幻想的な光彩を描画する
 */
export class LightingRenderer {
  readonly glowCanvas!: HTMLCanvasElement;
  private readonly glowCtx!: CanvasRenderingContext2D;
  private readonly glowImage!: ImageData;

  readonly bufR = new Float32Array(LIGHT_SIZE);
  readonly bufG = new Float32Array(LIGHT_SIZE);
  readonly bufB = new Float32Array(LIGHT_SIZE);

  private readonly tmpR = new Float32Array(LIGHT_SIZE);
  private readonly tmpG = new Float32Array(LIGHT_SIZE);
  private readonly tmpB = new Float32Array(LIGHT_SIZE);

  constructor(headless: boolean = false) {
    if (headless || typeof document === 'undefined') {
      return;
    }
    this.glowCanvas = document.createElement('canvas');
    this.glowCanvas.width = LIGHT_W;
    this.glowCanvas.height = LIGHT_H;
    const ctx = this.glowCanvas.getContext('2d');
    if (!ctx) throw new Error('Glow canvas 2D context failed');
    this.glowCtx = ctx;
    this.glowImage = ctx.createImageData(LIGHT_W, LIGHT_H);
  }

  /**
   * 発光マテリアルとスプライト光源を集計してボックスブラーを実行する
   */
  updateGlowMap(
    world: WorldGrid,
    extraLights?: ReadonlyArray<{ x: number; y: number; r: number; g: number; b: number }>
  ): void {
    this.bufR.fill(0);
    this.bufG.fill(0);
    this.bufB.fill(0);

    const types = world.type;
    const charges = world.charge;
    const nightBoost = world.isNight() ? 1.35 : 0.72;

    // 4x4 ブロックごとに発光強度を集計
    for (let ly = 0; ly < LIGHT_H; ly++) {
      const baseY = ly << 2;
      for (let lx = 0; lx < LIGHT_W; lx++) {
        const baseX = lx << 2;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;

        for (let dy = 0; dy < 4; dy++) {
          const row = (baseY + dy) << 8;
          for (let dx = 0; dx < 4; dx++) {
            const idx = row + baseX + dx;
            const mat = types[idx];
            if (mat === Mat.Air) continue;

            const glow = MATERIALS[mat].glowColor;
            if (glow) {
              rSum += glow[0];
              gSum += glow[1];
              bSum += glow[2];
            }
            const ch = charges[idx];
            if (ch > 20) {
              const s = ch * 0.65;
              rSum += s;
              gSum += s * 0.92;
              bSum += s * 0.45;
            }
          }
        }

        if (rSum > 0 || gSum > 0 || bSum > 0) {
          const li = ly * LIGHT_W + lx;
          const scale = 0.22 * nightBoost;
          this.bufR[li] = Math.min(255, rSum * scale);
          this.bufG[li] = Math.min(255, gSum * scale);
          this.bufB[li] = Math.min(255, bSum * scale);
        }
      }
    }

    // スプライト（ピカリん・ホタル等）の追加光源
    if (extraLights) {
      for (let k = 0; k < extraLights.length; k++) {
        const l = extraLights[k];
        const lx = l.x >> 2;
        const ly = l.y >> 2;
        if (lx >= 0 && lx < LIGHT_W && ly >= 0 && ly < LIGHT_H) {
          const li = ly * LIGHT_W + lx;
          this.bufR[li] = Math.min(255, this.bufR[li] + l.r * nightBoost);
          this.bufG[li] = Math.min(255, this.bufG[li] + l.g * nightBoost);
          this.bufB[li] = Math.min(255, this.bufB[li] + l.b * nightBoost);
        }
      }
    }

    // 2パスのセパラブル・ボックスブラーで柔らかい円形減衰グローを作る
    this.blurPass();
    this.blurPass();

    // カゲむし等の光忌避AIが O(1) で参照できるよう WorldGrid.lightLuma を更新（コア自身の微光は除外）
    world.updateLightField(extraLights);

    if (!this.glowImage) return;

    // ImageData へ書き込み
    const data = this.glowImage.data;
    for (let i = 0; i < LIGHT_SIZE; i++) {
      const r = Math.min(255, this.bufR[i] | 0);
      const g = Math.min(255, this.bufG[i] | 0);
      const b = Math.min(255, this.bufB[i] | 0);
      const maxC = Math.max(r, g, b);
      const p = i << 2;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = Math.min(220, maxC);
    }
    this.glowCtx.putImageData(this.glowImage, 0, 0);
  }

  private blurPass(): void {
    // 水平方向
    for (let y = 0; y < LIGHT_H; y++) {
      const row = y * LIGHT_W;
      for (let x = 0; x < LIGHT_W; x++) {
        const xm1 = x > 0 ? x - 1 : x;
        const xp1 = x < LIGHT_W - 1 ? x + 1 : x;
        const i = row + x;
        this.tmpR[i] = (this.bufR[row + xm1] + this.bufR[i] * 1.6 + this.bufR[row + xp1]) * 0.29;
        this.tmpG[i] = (this.bufG[row + xm1] + this.bufG[i] * 1.6 + this.bufG[row + xp1]) * 0.29;
        this.tmpB[i] = (this.bufB[row + xm1] + this.bufB[i] * 1.6 + this.bufB[row + xp1]) * 0.29;
      }
    }
    // 垂直方向
    for (let y = 0; y < LIGHT_H; y++) {
      const ym1 = (y > 0 ? y - 1 : y) * LIGHT_W;
      const y0 = y * LIGHT_W;
      const yp1 = (y < LIGHT_H - 1 ? y + 1 : y) * LIGHT_W;
      for (let x = 0; x < LIGHT_W; x++) {
        const i = y0 + x;
        this.bufR[i] = (this.tmpR[ym1 + x] + this.tmpR[i] * 1.6 + this.tmpR[yp1 + x]) * 0.29;
        this.bufG[i] = (this.tmpG[ym1 + x] + this.tmpG[i] * 1.6 + this.tmpG[yp1 + x]) * 0.29;
        this.bufB[i] = (this.tmpB[ym1 + x] + this.tmpB[i] * 1.6 + this.tmpB[yp1 + x]) * 0.29;
      }
    }
  }
}
