import { MAT_HARDNESS, Mat } from '../core/materials';
import { FLAG_INDESTRUCTIBLE, HEIGHT, WIDTH, WorldGrid } from '../core/world';
import { SpriteManager } from '../entities/sprites';
import { ProgressionManager } from './alchemist';

export type WeatherKind = 'clear' | 'monsoon' | 'heatwave' | 'starfall';
export type RaidPhase = 1 | 2 | 3 | 4;

export interface EcoStats {
  floraCount: number;
  powerTotal: number;
  spriteCount: number;
  miteCount: number;
  wealthScore: number;
  hasActiveAntenna: boolean;
}

/**
 * AIストーリーテラー「Mother Nature」＆ 4段階夜間襲撃ディレクター (SPEC 3.4)
 * - 昼夜サイクルと経過日数に応じて、カゲむし群と瘴気霧・気象イベントを段階的にエスカレートさせる
 * - 序盤 (Day 1〜3) は放置しない限り安全な少数出現、終盤 (Day 13+) は気を抜くと全滅し得るエクリプス襲撃へ至る
 */
export class Storyteller {
  currentWeather: WeatherKind = 'clear';
  weatherTimer: number = 0;
  cooldownTimer: number = 900;

  /** 今夜のカゲむし累計スポーン数と1晩の上限 */
  spawnedTonight: number = 0;
  nightQuota: number = 0;
  private wasNightLastTick: boolean = false;
  isEclipseNight: boolean = false;

  lastStats: EcoStats = {
    floraCount: 0,
    powerTotal: 0,
    spriteCount: 0,
    miteCount: 0,
    wealthScore: 0,
    hasActiveAntenna: false,
  };

  onWeatherChange?: (weather: WeatherKind) => void;
  onRaidStart?: (phase: RaidPhase, isEclipse: boolean) => void;

  reset(): void {
    this.currentWeather = 'clear';
    this.weatherTimer = 0;
    this.cooldownTimer = 900;
    this.spawnedTonight = 0;
    this.nightQuota = 0;
    this.wasNightLastTick = false;
    this.isEclipseNight = false;
  }

  /** 現在の経過日数・進行度から 4段階の体験・襲撃フェーズを返す */
  getRaidPhase(world: WorldGrid, progression: ProgressionManager): RaidPhase {
    if (world.dayCount >= 13 || (progression.toolTier >= 3 && world.dayCount >= 10)) {
      return 4;
    }
    if (world.dayCount >= 8 || progression.toolTier >= 3) {
      return 3;
    }
    if (world.dayCount >= 4 || progression.toolTier >= 2) {
      return 2;
    }
    return 1;
  }

  /** 手動または天候制御アンテナから気象イベントを発動する */
  triggerWeather(weather: WeatherKind, durationTicks: number = 960): void {
    this.currentWeather = weather;
    this.weatherTimer = weather === 'clear' ? 0 : durationTicks;
    this.cooldownTimer = 1100;
    this.onWeatherChange?.(weather);
  }

  /**
   * 毎フレームの気象効果適用・動的イベント抽選・夜間カゲむし襲撃スポーン制御
   */
  update(world: WorldGrid, sprites: SpriteManager, progression: ProgressionManager): void {
    if (world.tick % 60 === 0) {
      this.measureEcoWealth(world, sprites);
      progression.evaluateInfrastructure(world);
    }

    const isNightNow = world.isNight();

    // Alchemist Mode における日没（夜間突入）検知と襲撃クォータ設定
    if (progression.mode === 'alchemist') {
      if (isNightNow && !this.wasNightLastTick) {
        this.beginNightRaid(world, progression);
      } else if (!isNightNow && this.wasNightLastTick) {
        this.isEclipseNight = false;
        this.spawnedTonight = 0;
      }
      this.wasNightLastTick = isNightNow;

      if (isNightNow && progression.raidsEnabled) {
        this.stepNightRaidSpawning(world, sprites, progression);
      }
    } else {
      this.wasNightLastTick = isNightNow;
    }

    // アクティブな気象イベントの継続処理
    if (this.currentWeather !== 'clear') {
      this.applyActiveWeather(world);
      this.weatherTimer--;
      if (this.weatherTimer <= 0) {
        this.currentWeather = 'clear';
        world.ambientTempOffset = 0;
        this.onWeatherChange?.('clear');
      }
      return;
    }

    // 晴天時は環境温度オフセットを滑らかに 0 へ戻す
    if (world.ambientTempOffset !== 0 && world.tick % 10 === 0) {
      world.ambientTempOffset += world.ambientTempOffset > 0 ? -1 : 1;
    }

    if (progression.mode !== 'alchemist') return;

    if (this.cooldownTimer > 0) {
      this.cooldownTimer--;
      return;
    }

    const phase = this.getRaidPhase(world, progression);

    // Phase 3 以降は星のかけら獲得チャンスとして夜間に Starfall が発生しやすい
    if (phase >= 3 && isNightNow && world.rng.chance(0.06)) {
      this.triggerWeather('starfall', 880);
      return;
    }

    // 1秒ごとの動的気象抽選
    if (world.tick % 60 === 0 && world.rng.chance(0.18)) {
      const roll = world.rng.next();
      if (isNightNow && phase >= 3 && roll < 0.45) {
        this.triggerWeather('starfall', 840);
      } else if (!isNightNow && phase >= 3 && roll > 0.45) {
        // Phase 3+: 昼間の太陽熱波で水枯れ・発火プレッシャーを与える
        this.triggerWeather('heatwave', 780);
      } else if (phase >= 2) {
        this.triggerWeather('monsoon', 840);
      }
    }
  }

  /**
   * 日没時の夜間襲撃パラメータ決定（4段階エスカレーション）
   */
  private beginNightRaid(world: WorldGrid, progression: ProgressionManager): void {
    this.spawnedTonight = 0;
    if (!progression.raidsEnabled) {
      this.nightQuota = 0;
      this.isEclipseNight = false;
      return;
    }

    const phase = this.getRaidPhase(world, progression);
    if (phase === 1) {
      // Phase I (Day 1〜3): 3〜5体のみ。無防備でも1晩の最大被害は Vitality -16〜20 程度で全滅しない
      this.nightQuota = 3 + world.rng.nextInt(3);
      this.isEclipseNight = false;
    } else if (phase === 2) {
      // Phase II (Day 4〜7): 8〜13体。木壁をかじり始める＋夜間豪雨リスク
      this.nightQuota = 8 + world.rng.nextInt(6);
      this.isEclipseNight = false;
      if (this.currentWeather === 'clear' && world.rng.chance(0.45)) {
        this.triggerWeather('monsoon', 760);
      }
    } else if (phase === 3) {
      // Phase III (Day 8〜12): 18〜25体。東西両面＋地下空洞からの複合進行
      this.nightQuota = 18 + world.rng.nextInt(8);
      this.isEclipseNight = false;
    } else {
      // Phase IV (Day 13+): クライマックス「エクリプス・ナイト」（30〜42体＋流星嵐）
      this.nightQuota = 30 + world.rng.nextInt(13);
      this.isEclipseNight = true;
      this.triggerWeather('starfall', 960);
    }

    this.onRaidStart?.(phase, this.isEclipseNight);
  }

  /**
   * 夜間襲撃中のカゲむし＆瘴気霧のウェーブ出現処理
   * 光源網（湧き潰し）が敷かれた明るい場所からは湧かず、未開拓の暗闇からのみ出現する
   */
  private stepNightRaidSpawning(
    world: WorldGrid,
    sprites: SpriteManager,
    progression: ProgressionManager
  ): void {
    if (this.spawnedTonight >= this.nightQuota) return;

    const phase = this.getRaidPhase(world, progression);
    const interval = phase === 1 ? 150 : phase === 2 ? 85 : phase === 3 ? 48 : 28;
    if (world.tick % interval !== 0) return;

    // 東西の未開拓バイオーム端、または Phase 3 以降は地下の未照明空洞をスポーン候補とする
    const spawnWest = world.rng.chance(0.55);
    let sx = spawnWest ? 4 + world.rng.nextInt(26) : WIDTH - 5 - world.rng.nextInt(26);
    let sy = this.findSurfaceAirY(world, sx);

    if (phase >= 3 && world.rng.chance(0.28)) {
      // 地下暗所からの湧き判定（光源を置けば湧き潰し可能！）
      const cx = 32 + world.rng.nextInt(WIDTH - 64);
      const cy = 108 + world.rng.nextInt(22);
      if (
        world.inBounds(cx, cy) &&
        world.getMat(cx, cy) === Mat.Air &&
        Math.abs(cx - world.coreX) > 24 &&
        world.getLightAt(cx, cy) < 35
      ) {
        sx = cx;
        sy = cy;
      }
    }

    if (sy === -1) return;

    // 湧き潰し判定：すでにプレイヤーが発光キノコや灯りで明るく照らしている地点からは出現しない
    if (world.getLightAt(sx, sy) >= 55) {
      return;
    }

    const spawned = sprites.spawn('shade_mite', sx, sy);
    if (spawned) {
      this.spawnedTonight++;
      // 出現地点に淡い瘴気霧を添える
      if (world.inBounds(sx, sy - 1) && world.getMat(sx, sy - 1) === Mat.Air) {
        world.setCell(sx, sy - 1, Mat.Miasma, 110, 14);
      }
    }
  }

  private findSurfaceAirY(world: WorldGrid, x: number): number {
    for (let y = 36; y < 104; y++) {
      if (world.getMat(x, y) === Mat.Air && world.getMat(x, y + 1) !== Mat.Air) {
        return y;
      }
    }
    return -1;
  }

  /**
   * 現在発生中の気象効果をグリッドへ反映する
   */
  private applyActiveWeather(world: WorldGrid): void {
    if (this.currentWeather === 'monsoon') {
      world.ambientTempOffset = -3;
      if (world.tick % 3 === 0) {
        const drops = 2 + world.rng.nextInt(2);
        for (let k = 0; k < drops; k++) {
          const rx = 4 + world.rng.nextInt(WIDTH - 8);
          if (world.getMat(rx, 2) === Mat.Air) {
            world.setCell(rx, 2, Mat.Water, 0, 18);
          }
        }
      }
    } else if (this.currentWeather === 'heatwave') {
      if (world.ambientTempOffset < 28 && world.tick % 8 === 0) {
        world.ambientTempOffset++;
      }
    } else if (this.currentWeather === 'starfall') {
      const interval = this.isEclipseNight ? 36 : 55;
      if (world.tick % interval === 0) {
        const sx = 12 + world.rng.nextInt(WIDTH - 24);
        if (!world.hasCore || Math.abs(sx - world.coreX) > 9) {
          if (world.getMat(sx, 3) === Mat.Air) {
            world.setCell(sx, 3, Mat.StarShard, 0, 75);
            if (world.getMat(sx, 2) === Mat.Air) {
              world.setCell(sx, 2, Mat.Steam, 25, 90);
            }
          }
          // エクリプス・ナイト時は流星の衝撃で露出している軟質表層 (H=1) がわずかに削れる場合がある（石・ガラス屋根なら無傷）
          if (this.isEclipseNight && world.rng.chance(0.35)) {
            const sy = this.findSurfaceAirY(world, sx);
            if (sy !== -1 && sy + 1 < HEIGHT - 4) {
              const hitIdx = world.idx(sx, sy + 1);
              const hitMat = world.type[hitIdx];
              if (
                MAT_HARDNESS[hitMat] === 1 &&
                (world.flags[hitIdx] & FLAG_INDESTRUCTIBLE) === 0
              ) {
                world.setCell(sx, sy + 1, Mat.Fire, 35, 480);
              }
            }
          }
        }
      }
    }
  }

  /**
   * 箱庭内の緑化量・総電力・スプライト個体数・カゲむし数・天候アンテナ有無を集計する
   */
  measureEcoWealth(world: WorldGrid, sprites: SpriteManager): EcoStats {
    let flora = 0;
    let power = 0;
    let hasAntenna = false;

    const types = world.type;
    const charges = world.charge;
    for (let i = 0; i < types.length; i++) {
      const m = types[i];
      if (
        m === Mat.PlantStem ||
        m === Mat.Leaf ||
        m === Mat.Flower ||
        m === Mat.Mushroom ||
        m === Mat.VoltFern
      ) {
        flora++;
      } else if (m === Mat.WeatherAntenna) {
        hasAntenna = true;
      }
      if (charges[i] > 20) {
        power += charges[i] >> 4;
      }
    }

    const counts = sprites.countByKind();
    const spriteCount = counts.aqua_puff + counts.root_roller + counts.spark_bit;
    const miteCount = counts.shade_mite;
    const wealthScore = Math.round(flora * 0.35 + power * 0.25 + spriteCount * 8);

    this.lastStats = {
      floraCount: flora,
      powerTotal: power,
      spriteCount,
      miteCount,
      wealthScore,
      hasActiveAntenna: hasAntenna,
    };
    return this.lastStats;
  }
}
