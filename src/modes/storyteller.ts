import { Mat } from '../core/materials';
import { WIDTH, WorldGrid } from '../core/world';
import { SpriteManager } from '../entities/sprites';
import { ProgressionManager } from './alchemist';

export type WeatherKind = 'clear' | 'monsoon' | 'heatwave' | 'starfall';

export interface EcoStats {
  floraCount: number;
  powerTotal: number;
  spriteCount: number;
  wealthScore: number;
  hasActiveAntenna: boolean;
}

/**
 * AIストーリーテラー「Mother Nature（母なる自然）」 (Phase 4)
 * 箱庭の生態系資産をリアルタイム計測し、停滞を打破する気象イベントを動的に発生させる
 */
export class Storyteller {
  currentWeather: WeatherKind = 'clear';
  weatherTimer: number = 0;
  cooldownTimer: number = 900; // 初回イベントまでの猶予フレーム

  lastStats: EcoStats = {
    floraCount: 0,
    powerTotal: 0,
    spriteCount: 0,
    wealthScore: 0,
    hasActiveAntenna: false,
  };

  onWeatherChange?: (weather: WeatherKind) => void;

  reset(): void {
    this.currentWeather = 'clear';
    this.weatherTimer = 0;
    this.cooldownTimer = 900;
  }

  /** 手動または天候制御アンテナから気象イベントを発動する */
  triggerWeather(weather: WeatherKind, durationTicks: number = 960): void {
    this.currentWeather = weather;
    this.weatherTimer = weather === 'clear' ? 0 : durationTicks;
    this.cooldownTimer = 1100;
    this.onWeatherChange?.(weather);
  }

  /**
   * 毎フレームの気象効果適用と動的イベント発生判定
   */
  update(world: WorldGrid, sprites: SpriteManager, progression: ProgressionManager): void {
    // 60フレーム（1秒）ごとに箱庭のエコ資産を計測
    if (world.tick % 60 === 0) {
      this.measureEcoWealth(world, sprites);
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

    // Cozy Toy Mode では自然災害を自動発生させない（SPEC 3.1準拠）
    if (progression.mode !== 'alchemist') return;

    if (this.cooldownTimer > 0) {
      this.cooldownTimer--;
      return;
    }

    // Stage 5 では「星のかけら」納品のため、夜間に星屑の夜が発生しやすいよう配慮
    if (progression.stage >= 5 && world.isNight() && world.rng.chance(0.08)) {
      this.triggerWeather('starfall', 900);
      return;
    }

    // エコ資産に応じた動的イベント抽選（1秒ごとに判定）
    if (world.tick % 60 === 0 && world.rng.chance(0.18)) {
      const roll = world.rng.next();
      if (world.isNight() && (roll < 0.42 || progression.stage >= 4)) {
        this.triggerWeather('starfall', 840);
      } else if (this.lastStats.wealthScore > 80 && roll > 0.62) {
        this.triggerWeather('heatwave', 780);
      } else {
        this.triggerWeather('monsoon', 840);
      }
    }
  }

  /**
   * 現在発生中の気象効果をグリッドへ反映する
   */
  private applyActiveWeather(world: WorldGrid): void {
    if (this.currentWeather === 'monsoon') {
      // 恵みの梅雨：上空から心地よい雨が降り注ぐ
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
      // 太陽フレアと熱波：全体気温を段階的に上昇させる
      if (world.ambientTempOffset < 28 && world.tick % 8 === 0) {
        world.ambientTempOffset++;
      }
    } else if (this.currentWeather === 'starfall') {
      // 星屑の夜：夜空から高エネルギー鉱石「星のかけら (StarShard)」が降り注ぐ
      if (world.tick % 55 === 0) {
        const sx = 12 + world.rng.nextInt(WIDTH - 24);
        // Alchemist コア直上だけは避けて周辺の屋根・丘に降らせる
        if (!world.hasCore || Math.abs(sx - world.coreX) > 8) {
          if (world.getMat(sx, 3) === Mat.Air) {
            world.setCell(sx, 3, Mat.StarShard, 0, 65);
            // 流星の尾として小さな火花を添える
            if (world.getMat(sx, 2) === Mat.Air) {
              world.setCell(sx, 2, Mat.Steam, 25, 80);
            }
          }
        }
      }
    }
  }

  /**
   * 箱庭内の緑化量・総電力・スプライト個体数・天候アンテナ有無を集計する
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

    const spriteCount = sprites.sprites.length;
    const wealthScore = Math.round(flora * 0.35 + power * 0.25 + spriteCount * 8);

    this.lastStats = {
      floraCount: flora,
      powerTotal: power,
      spriteCount,
      wealthScore,
      hasActiveAntenna: hasAntenna,
    };
    return this.lastStats;
  }
}

