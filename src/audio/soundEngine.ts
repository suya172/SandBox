import { MAT_CATEGORY, Mat, MatCategory, MatId } from '../core/materials';

/** Cメジャー・ペンタトニックスケール（どの組み合わせで鳴っても心地よい五音音階） */
const PENTATONIC_HZ = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];

/**
 * Web Audio API による完全プロシージャル音響エンジン (Phase 3)
 * 外部MP3/WAVアセットを一切使用せず、ASMRブラシ粒子音・納品チャイム・環境雨音を生成する
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private muted: boolean = false;
  private lastBrushSoundAt: number = 0;
  private lastAmbientBellAt: number = 0;

  /** ミュート状態を切り替え、現在のミュート状態を返す */
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.45, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** 初回ユーザー操作時に AudioContext を初期化・アンロックする */
  unlock(): void {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.45;
      this.masterGain.connect(this.ctx.destination);

      // 1.5秒のホワイトノイズバッファを事前生成（雨音・粒子ASMRで共有再利用）
      const sampleRate = this.ctx.sampleRate;
      this.noiseBuffer = this.ctx.createBuffer(1, sampleRate * 1.5, sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      // 環境雨音・蒸気音用ループノイズ＋ローパスフィルタ
      const rainSrc = this.ctx.createBufferSource();
      rainSrc.buffer = this.noiseBuffer;
      rainSrc.loop = true;

      this.rainFilter = this.ctx.createBiquadFilter();
      this.rainFilter.type = 'lowpass';
      this.rainFilter.frequency.value = 650;

      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0.0;

      rainSrc.connect(this.rainFilter);
      this.rainFilter.connect(this.rainGain);
      this.rainGain.connect(this.masterGain);
      rainSrc.start();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  /**
   * ブラシ描画時の心地よいASMR粒子サウンド
   */
  playBrushSound(mat: MatId): void {
    if (this.muted || !this.ctx || !this.masterGain) return;
    const nowMs = performance.now();
    if (nowMs - this.lastBrushSoundAt < 55) return;
    this.lastBrushSoundAt = nowMs;

    const t = this.ctx.currentTime;
    const cat = MAT_CATEGORY[mat];

    if (mat === Mat.Air) {
      // 消しゴム：柔らかい風切り音
      this.triggerFilteredNoise(t, 0.05, 500, 0.06);
      return;
    }

    if (cat === MatCategory.Liquid) {
      // 水・蜜：ぷるんとした水滴サイン波ピッチベンド
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const base = 360 + Math.random() * 220;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.65, t + 0.065);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.08);
      return;
    }

    if (cat === MatCategory.Powder) {
      // 砂・土・種：さらさらとした微細粒子ノイズ
      this.triggerFilteredNoise(t, 0.04, 1800 + Math.random() * 900, 0.05);
      return;
    }

    if (cat === MatCategory.Energy) {
      // 火・雷：パチパチ弾けるノイズ
      this.triggerFilteredNoise(t, 0.07, 900 + Math.random() * 600, 0.09);
      return;
    }

    // 木材・石・ガラス・回路：ペンタトニックスケールのマリンバ風トーン
    const freq = PENTATONIC_HZ[(Math.random() * PENTATONIC_HZ.length) | 0];
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = mat === Mat.Glass || mat === Mat.Copper ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  /**
   * 納品・フェーズ解放・気象イベント開始時のペンタトニック・シンセチャイム
   */
  playChime(kind: 'deliver' | 'unlock' | 'weather'): void {
    if (this.muted || !this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;

    if (kind === 'deliver') {
      const idx = 3 + ((Math.random() * 5) | 0);
      this.playBellNote(PENTATONIC_HZ[idx], t, 0.22, 0.07);
    } else if (kind === 'unlock') {
      // 華やかな上昇アルペジオ
      const notes = [0, 2, 3, 5, 7];
      notes.forEach((nIdx, step) => {
        this.playBellNote(PENTATONIC_HZ[nIdx], t + step * 0.085, 0.55, 0.12);
      });
    } else {
      // 気象変化の神秘的な2音コード
      this.playBellNote(PENTATONIC_HZ[1], t, 0.65, 0.08);
      this.playBellNote(PENTATONIC_HZ[4], t + 0.12, 0.75, 0.08);
    }
  }

  /**
   * ワールドの雨量・水循環量に応じたプロシージャル環境音と癒やしの風鈴アンビエント更新
   */
  updateAmbient(rainFactor: number, isNight: boolean): void {
    if (!this.ctx || !this.rainGain || !this.rainFilter || this.muted) return;
    const t = this.ctx.currentTime;

    const targetGain = Math.min(0.14, rainFactor * 0.12);
    this.rainGain.gain.setTargetAtTime(targetGain, t, 0.4);
    this.rainFilter.frequency.setTargetAtTime(isNight ? 520 : 780, t, 0.5);

    // 約5〜8秒おきに極小音量のコージー・アンビエントベルを鳴らす
    const nowMs = performance.now();
    if (nowMs - this.lastAmbientBellAt > 6200) {
      this.lastAmbientBellAt = nowMs + Math.random() * 2500;
      const note = PENTATONIC_HZ[(Math.random() * 6) | 0] * (isNight ? 0.5 : 1.0);
      this.playBellNote(note, t, 1.6, 0.028);
    }
  }

  private playBellNote(freq: number, startTime: number, duration: number, peakGain: number): void {
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0008, startTime + duration);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  private triggerFilteredNoise(
    startTime: number,
    duration: number,
    centerFreq: number,
    peakGain: number
  ): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = centerFreq;
    filter.Q.value = 2.0;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peakGain, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(startTime, Math.random() * 0.8, duration);
  }
}

