import { SoundEngine } from '../audio/soundEngine';
import { BgMat, MAT_HARDNESS, Mat, MatId } from '../core/materials';
import { stepSimulation } from '../core/simulation';
import { GameMode, generateTerrain } from '../core/terrainGen';
import { FLAG_INDESTRUCTIBLE, FLAG_RUIN, HEIGHT, WIDTH, WorldGrid } from '../core/world';
import { SpriteManager } from '../entities/sprites';
import { ProgressionManager } from '../modes/alchemist';
import { Storyteller, WeatherKind } from '../modes/storyteller';
import { LightingRenderer } from '../render/lighting';
import { WorldRenderer } from '../render/renderer';
import { stepProceduralDecor } from '../systems/building';
import { stepPowerAndMachines } from '../systems/power';
import { BlueprintManager } from '../ugc/blueprint';
import { embedWorldIntoPng, extractWorldFromPng } from '../ugc/pngStego';
import { deserializeWorld, serializeWorld } from '../ugc/serializer';
import {
  CollapseModalController,
  createUIButton,
  escapeHtml,
  InputModalController,
} from './components';
import { DictKey, Locale, MATERIAL_LABELS, t } from './i18n';
import { applyHybridBrush } from './viewport';

const DISPLAY_SCALE = 4;
const DISPLAY_W = WIDTH * DISPLAY_SCALE;   // 1024
const DISPLAY_H = HEIGHT * DISPLAY_SCALE;  // 576

/* Canvas オーバーレイ描画も UI Design System のトークン値と一致させる */
const TOKEN_COLOR_ACCENT = '#A4B879';
const TOKEN_COLOR_WARNING = '#D6A45F';
const TOKEN_COLOR_TEXT_PRIMARY = '#E6E8DC';

/**
 * TERRA-WEAVE アプリケーション統合コントローラ & フィールド観測UI
 * AGENTS.md UI Design System 準拠
 */
export class TerraWeaveApp {
  readonly world = new WorldGrid(20261029);
  readonly renderer = new WorldRenderer();
  readonly lighting = new LightingRenderer();
  readonly sprites = new SpriteManager();
  readonly sound = new SoundEngine();
  readonly progression = new ProgressionManager();
  readonly storyteller = new Storyteller();
  readonly blueprints = new BlueprintManager();
  readonly modal = new InputModalController();
  readonly collapseModal = new CollapseModalController();

  locale: Locale = 'ja';
  selectedMat: MatId = Mat.Water;
  brushRadius: number = 2; // 0: 1px, 2: S, 4: M, 7: L
  simSpeed: 0 | 1 | 2 = 1;

  // ビューポート（ズーム＆パン）
  zoom: number = 1.0;
  panX: number = 0;
  panY: number = 0;

  // マウス入力・フィードバック状態
  private hoverX: number = 128;
  private hoverY: number = 72;
  private isPointerInside: boolean = false;
  private isDrawing: boolean = false;
  private drawButton: number = 0;
  private isPanning: boolean = false;
  private isSpaceDown: boolean = false;
  private lastClientX: number = 0;
  private lastClientY: number = 0;
  private blockedCursorUntil: number = 0;
  private lastCoreHitAt: number = 0;
  private transientHintTimer: number | null = null;

  // ブループリント範囲選択状態
  private isCapturingBp: boolean = false;
  private bpDragStart: { x: number; y: number } | null = null;

  // FPS 計測
  private fps: number = 60;
  private frameCounter: number = 0;
  private lastFpsTime: number = performance.now();
  private toastTimer: number | null = null;

  // 主要DOM参照
  private root: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private headerEl!: HTMLElement;
  private sidebarEl!: HTMLElement;
  private dockEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private floatingHintEl!: HTMLElement;
  private dropOverlayEl!: HTMLElement;

  // 動的更新用DOM参照
  private readoutStripEl!: HTMLElement;
  private timeReadoutEl!: HTMLElement;
  private weatherReadoutEl!: HTMLElement;
  private vitalityStripEl: HTMLElement | null = null;
  private tierBadgeEl: HTMLElement | null = null;
  private vitalityFillEl: HTMLElement | null = null;
  private vitalityNumEl: HTMLElement | null = null;
  private goalBodyEl!: HTMLElement;
  private inspectorBodyEl!: HTMLElement;
  private spriteBodyEl!: HTMLElement;
  private bpListEl!: HTMLElement;
  private readonly stockBadgeEls = new Map<MatId, { btn: HTMLButtonElement; badge: HTMLElement }>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.sanitizeStoredBlueprintNames();
    this.setupCoreCallbacks();
    this.buildLayout();
    this.initInitialWorld();
    this.bindEvents();
    this.refreshStaticUI();
    requestAnimationFrame(this.loop);
  }

  /** 既存 localStorage に絵文字付きプリセット名が残っている場合もクリーンな名称へ正規化する */
  private sanitizeStoredBlueprintNames(): void {
    for (const bp of this.blueprints.blueprints) {
      if (bp.id === 'preset_greenhouse') bp.name = 'Glass Greenhouse';
      if (bp.id === 'preset_rotor') bp.name = 'Rotor Generator';
    }
  }

  private isAnyModalOpen(): boolean {
    return this.modal.isOpen() || this.collapseModal.isOpen();
  }

  private setupCoreCallbacks(): void {
    this.world.onDawn = (dayCount) => {
      if (this.progression.mode === 'alchemist') {
        this.progression.checkTierPromotion(dayCount);
        this.world.saveDawnSnapshot();
        this.progression.saveDawnState();
      }
      this.updateHeaderReadouts();
      this.updateSidebarDynamic();
    };

    this.world.onCoreDeliver = (kind, amount) => {
      this.progression.recordDelivery(kind, amount, this.world.dayCount);
    };

    this.world.onCoreDamaged = (_damage, remaining) => {
      this.lastCoreHitAt = performance.now();
      if (remaining <= 0 && !this.collapseModal.isOpen()) {
        this.sound.playAlertTone('collapse');
        this.simSpeed = 0;
        this.refreshStaticUI();
        this.openCollapseModal();
      } else if (remaining > 0) {
        this.sound.playAlertTone('damage');
        this.updateHeaderReadouts();
      }
    };

    this.progression.onDeliver = () => {
      this.sound.playChime('deliver');
    };

    this.progression.onTierUnlocked = (newTier, unlocked) => {
      this.sound.playChime('unlock');
      const names = unlocked.map((m) => MATERIAL_LABELS[m][this.locale]).join(', ');
      this.showToast(`Tier ${newTier} — ${t(this.locale, 'toast_tier_unlocked')} ${names}`, 'default');
      this.refreshStaticUI();
    };

    this.progression.onInfiniteUnlocked = (mat) => {
      this.sound.playChime('unlock');
      const label = MATERIAL_LABELS[mat][this.locale];
      this.showToast(`${t(this.locale, 'toast_inf_unlocked')} ${label}`, 'default');
      this.updatePaletteStocks();
    };

    this.storyteller.onRaidStart = (_phase, isEclipse) => {
      this.sound.playAlertTone('dusk');
      this.showToast(
        t(this.locale, isEclipse ? 'toast_eclipse' : 'toast_raid_start'),
        isEclipse ? 'error' : 'warning'
      );
      this.updateHeaderReadouts();
    };

    this.storyteller.onWeatherChange = (weather) => {
      if (weather !== 'clear') {
        this.sound.playChime('weather');
        const key = `weather_${weather}` as DictKey;
        this.showToast(`${t(this.locale, 'toast_weather')} ${t(this.locale, key)}`, 'warning');
      }
      this.updateHeaderReadouts();
    };
  }

  private openCollapseModal(): void {
    const loc = this.locale;
    this.collapseModal.open({
      title: t(loc, 'collapse_title'),
      description: t(loc, 'collapse_desc'),
      retryLabel: t(loc, 'btn_retry_dawn'),
      newWorldLabel: t(loc, 'btn_collapse_new'),
      onRetryDawn: () => {
        if (this.world.hasDawnSnapshot()) {
          this.world.restoreDawnSnapshot();
          this.progression.restoreDawnState();
        } else {
          this.world.coreVitality = this.world.maxCoreVitality;
        }
        this.sprites.clearMites();
        this.storyteller.reset();
        this.simSpeed = 1;
        this.showToast(t(this.locale, 'toast_dawn_restored'), 'default');
        this.refreshStaticUI();
      },
      onNewWorld: () => {
        this.simSpeed = 1;
        this.startNewWorld('alchemist');
      },
    });
  }

  private initInitialWorld(): void {
    if (window.location.hash.startsWith('#world=')) {
      const ok = deserializeWorld(window.location.hash, this.world, this.progression);
      if (ok) {
        this.sprites.clear();
        if (this.progression.mode === 'alchemist') {
          this.world.saveDawnSnapshot();
          this.progression.saveDawnState();
        }
        return;
      }
    }
    this.startNewWorld('cozy', 20261029);
  }

  startNewWorld(mode: GameMode, seed?: number): void {
    const nextSeed = seed ?? ((Math.random() * 0x7fffffff) | 0);
    this.collapseModal.close();
    this.progression.reset(mode);
    this.storyteller.reset();
    this.sprites.clear();
    generateTerrain(this.world, mode, nextSeed);
    if (mode === 'alchemist') {
      this.progression.saveDawnState();
    }

    if (!this.progression.isBrushUnlocked(this.selectedMat)) {
      this.selectedMat = Mat.Water;
    }
    this.refreshStaticUI();
  }

  private buildLayout(): void {
    this.root.innerHTML = '';

    this.headerEl = document.createElement('header');
    this.headerEl.className = 'tw-header';

    const workspace = document.createElement('main');
    workspace.className = 'tw-workspace';

    const stage = document.createElement('div');
    stage.className = 'tw-canvas-stage';

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'sim-canvas';
    this.canvas.width = DISPLAY_W;
    this.canvas.height = DISPLAY_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Main display canvas 2D context failed');
    this.ctx = ctx;

    this.floatingHintEl = document.createElement('div');
    this.floatingHintEl.className = 'tw-floating-hint';
    this.floatingHintEl.hidden = true;

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'tw-toast';

    this.dropOverlayEl = document.createElement('div');
    this.dropOverlayEl.className = 'tw-drop-overlay';

    stage.append(this.canvas, this.floatingHintEl, this.toastEl, this.dropOverlayEl);

    this.sidebarEl = document.createElement('aside');
    this.sidebarEl.className = 'tw-sidebar';

    workspace.append(stage, this.sidebarEl);

    this.dockEl = document.createElement('footer');
    this.dockEl.className = 'tw-dock';

    this.root.append(
      this.headerEl,
      workspace,
      this.dockEl,
      this.modal.backdropEl,
      this.collapseModal.backdropEl
    );
  }

  /**
   * モード切替・アンロック・言語切替時にUI全体を再構築する
   */
  refreshStaticUI(): void {
    const loc = this.locale;
    this.dropOverlayEl.textContent = t(loc, 'drop_overlay');

    // 1. トップ観測機器バー (HUD Header)
    this.headerEl.innerHTML = '';
    this.vitalityStripEl = null;
    this.tierBadgeEl = null;
    this.vitalityFillEl = null;
    this.vitalityNumEl = null;

    const brand = document.createElement('div');
    brand.className = 'tw-brand';
    brand.innerHTML = `<span class="tw-brand-title">TERRA-WEAVE</span><span class="tw-brand-sub">256×144</span>`;

    const center = document.createElement('div');
    center.className = 'tw-header-center';

    const modeSeg = document.createElement('div');
    modeSeg.className = 'tw-seg';
    modeSeg.append(
      createUIButton({
        label: t(loc, 'mode_cozy'),
        variant: 'segment',
        active: this.progression.mode === 'cozy',
        onClick: () => {
          if (this.progression.mode !== 'cozy') this.startNewWorld('cozy');
        },
      }),
      createUIButton({
        label: t(loc, 'mode_alchemist'),
        variant: 'segment',
        active: this.progression.mode === 'alchemist',
        onClick: () => {
          if (this.progression.mode !== 'alchemist') this.startNewWorld('alchemist');
        },
      })
    );

    this.readoutStripEl = document.createElement('div');
    this.readoutStripEl.className = 'tw-readout-strip';
    this.timeReadoutEl = document.createElement('span');
    this.timeReadoutEl.className = 'tw-readout-item';
    const sep = document.createElement('span');
    sep.className = 'tw-divider-v';
    this.weatherReadoutEl = document.createElement('span');
    this.weatherReadoutEl.className = 'tw-readout-item';
    this.readoutStripEl.append(this.timeReadoutEl, sep, this.weatherReadoutEl);

    center.append(modeSeg, this.readoutStripEl);

    // Alchemist Mode 時：ツールティア & テラリウム・コア活力計器を表示
    if (this.progression.mode === 'alchemist') {
      const vitStrip = document.createElement('div');
      vitStrip.className = 'tw-vitality-strip';

      const tierBadge = document.createElement('span');
      tierBadge.className = 'tw-tier-badge';
      tierBadge.textContent = `Tier ${this.progression.toolTier}`;

      const sepV = document.createElement('span');
      sepV.className = 'tw-divider-v';

      const vitLabel = document.createElement('span');
      vitLabel.className = 'tw-readout-muted';
      vitLabel.textContent = t(loc, 'core_vitality');

      const meter = document.createElement('div');
      meter.className = 'tw-vitality-meter';
      const fill = document.createElement('div');
      fill.className = 'tw-vitality-fill';
      meter.appendChild(fill);

      const num = document.createElement('span');
      num.className = 'tw-vitality-num';

      vitStrip.append(tierBadge, sepV, vitLabel, meter, num);
      center.appendChild(vitStrip);

      this.vitalityStripEl = vitStrip;
      this.tierBadgeEl = tierBadge;
      this.vitalityFillEl = fill;
      this.vitalityNumEl = num;
    }

    const skyControlUnlocked =
      this.progression.mode === 'cozy' ||
      this.progression.toolTier >= 4 ||
      this.storyteller.lastStats.hasActiveAntenna;

    // Cozy Mode または 天候アンテナ / Tier 4 解放時は矩形セグメントの天候トリガーを表示（絵文字不使用）
    if (skyControlUnlocked) {
      const wSeg = document.createElement('div');
      wSeg.className = 'tw-seg';
      const weathers: WeatherKind[] = ['clear', 'monsoon', 'heatwave', 'starfall'];
      for (const wk of weathers) {
        wSeg.appendChild(
          createUIButton({
            label: t(loc, `weather_short_${wk}` as DictKey),
            title: t(loc, `weather_${wk}` as DictKey),
            variant: 'segment',
            active: this.storyteller.currentWeather === wk,
            onClick: () => {
              this.storyteller.triggerWeather(wk, 960);
              this.refreshStaticUI();
            },
          })
        );
      }
      center.appendChild(wSeg);

      // Alchemist Mode で環境支配（Tier 4 または 天候アンテナ稼働）に到達したら夜間襲撃 ON/OFF も任意切替可能
      if (this.progression.mode === 'alchemist') {
        const raidSeg = document.createElement('div');
        raidSeg.className = 'tw-seg';
        raidSeg.append(
          createUIButton({
            label: `${t(loc, 'raid_label')} ${t(loc, 'raid_on')}`,
            variant: 'segment',
            active: this.progression.raidsEnabled,
            onClick: () => {
              this.progression.raidsEnabled = true;
              this.refreshStaticUI();
            },
          }),
          createUIButton({
            label: t(loc, 'raid_off'),
            variant: 'segment',
            active: !this.progression.raidsEnabled,
            onClick: () => {
              this.progression.raidsEnabled = false;
              this.sprites.clearMites();
              this.refreshStaticUI();
            },
          })
        );
        center.appendChild(raidSeg);
      }
    }

    const right = document.createElement('div');
    right.className = 'tw-header-right';

    const btnLang = createUIButton({
      label: loc === 'ja' ? 'JA / EN' : 'EN / JA',
      title: 'Switch Language',
      onClick: () => {
        this.locale = this.locale === 'ja' ? 'en' : 'ja';
        this.refreshStaticUI();
      },
    });

    const btnMute = createUIButton({
      icon: this.sound.isMuted() ? 'volumeOff' : 'volumeOn',
      title: this.sound.isMuted() ? 'Unmute Audio' : 'Mute Audio',
      active: this.sound.isMuted(),
      onClick: () => {
        this.sound.unlock();
        this.sound.toggleMute();
        this.refreshStaticUI();
      },
    });

    right.append(btnLang, btnMute);
    this.headerEl.append(brand, center, right);

    // 2. 右サイドパネル（個別カードを廃止し、1pxセパレータ区切りのフラット計器セクションで構成）
    this.sidebarEl.innerHTML = '';

    // Section 1: 目標 / 観測ノート
    const goalSec = document.createElement('section');
    goalSec.className = 'tw-section';
    const goalHeader = document.createElement('div');
    goalHeader.className = 'tw-section-header';
    goalHeader.textContent =
      this.progression.mode === 'alchemist' ? t(loc, 'panel_goal') : t(loc, 'panel_tips');
    this.goalBodyEl = document.createElement('div');
    goalSec.append(goalHeader, this.goalBodyEl);

    // Section 2: セル観測値 (Inspector)
    const inspSec = document.createElement('section');
    inspSec.className = 'tw-section';
    const inspHeader = document.createElement('div');
    inspHeader.className = 'tw-section-header';
    inspHeader.innerHTML = `<span>${escapeHtml(t(loc, 'panel_inspector'))}</span><span id="tw-fps" class="tw-fps-readout">${this.fps} FPS</span>`;
    this.inspectorBodyEl = document.createElement('div');
    this.inspectorBodyEl.className = 'tw-kv-grid';
    inspSec.append(inspHeader, this.inspectorBodyEl);

    // Section 3: スプライト個体数
    const spriteSec = document.createElement('section');
    spriteSec.className = 'tw-section';
    const spriteHeader = document.createElement('div');
    spriteHeader.className = 'tw-section-header';
    spriteHeader.textContent = t(loc, 'panel_sprites');
    this.spriteBodyEl = document.createElement('div');
    this.spriteBodyEl.className = 'tw-kv-grid';
    spriteSec.append(spriteHeader, this.spriteBodyEl);

    // Section 4: ブループリント
    const bpSec = document.createElement('section');
    bpSec.className = 'tw-section';
    const bpHeader = document.createElement('div');
    bpHeader.className = 'tw-section-header';
    bpHeader.textContent = t(loc, 'panel_blueprints');

    const bpActions = document.createElement('div');
    bpActions.className = 'tw-action-row';
    bpActions.appendChild(
      createUIButton({
        label: t(loc, 'btn_capture_bp'),
        icon: 'capture',
        variant: 'ghost',
        active: this.isCapturingBp,
        onClick: () => {
          this.isCapturingBp = !this.isCapturingBp;
          this.blueprints.activeBlueprintId = null;
          this.bpDragStart = null;
          this.updateFloatingHint();
          this.refreshStaticUI();
        },
      })
    );

    if (this.blueprints.activeBlueprintId) {
      bpActions.appendChild(
        createUIButton({
          label: t(loc, 'btn_cancel_bp'),
          variant: 'ghost',
          onClick: () => {
            this.blueprints.activeBlueprintId = null;
            this.refreshStaticUI();
          },
        })
      );
    }

    this.bpListEl = document.createElement('div');
    this.bpListEl.className = 'tw-bp-list';
    this.renderBlueprintItems();

    bpSec.append(bpHeader, bpActions, this.bpListEl);

    // Section 5: ワールド入出力 (Share / Load)
    const shareSec = document.createElement('section');
    shareSec.className = 'tw-section';
    const shareHeader = document.createElement('div');
    shareHeader.className = 'tw-section-header';
    shareHeader.textContent = t(loc, 'panel_share');

    const shareBtns = document.createElement('div');
    shareBtns.className = 'tw-action-row';
    shareBtns.append(
      createUIButton({
        label: t(loc, 'btn_copy_url'),
        icon: 'link',
        variant: 'ghost',
        onClick: () => {
          void this.copyShareUrl();
        },
      }),
      createUIButton({
        label: t(loc, 'btn_load_code'),
        icon: 'upload',
        variant: 'ghost',
        onClick: () => {
          this.openLoadCodeModal();
        },
      })
    );

    const dropHint = document.createElement('p');
    dropHint.className = 'tw-hint-small';
    dropHint.textContent = t(loc, 'png_drop_hint');
    shareSec.append(shareHeader, shareBtns, dropHint);

    this.sidebarEl.append(goalSec, inspSec, spriteSec, bpSec, shareSec);

    // 3. 下部マテリアルパレット＆操作ドック
    this.dockEl.innerHTML = '';
    this.stockBadgeEls.clear();
    const brushRow = document.createElement('div');
    brushRow.className = 'tw-brushes';

    const paletteItems = this.progression.getPaletteDisplayBrushes();
    for (let i = 0; i < paletteItems.length; i++) {
      const item = paletteItems[i];
      const mat = item.mat;
      const info = MATERIAL_LABELS[mat];
      const btn = document.createElement('button');
      btn.type = 'button';

      if (!item.unlocked) {
        btn.disabled = true;
        btn.className = 'tw-brush-btn is-locked-preview';
        const suffix = t(loc, 'locked_preview_suffix');
        btn.title = `${info[loc]} — ${t(loc, 'locked_preview_prefix')} ${item.requiredTier}${suffix ? ` ${suffix}` : ''}`;
        btn.innerHTML = `<span>${escapeHtml(info[loc])}</span><span class="tw-brush-tier-req">T${item.requiredTier}</span>`;
        brushRow.appendChild(btn);
        continue;
      }

      const isSelected = !this.blueprints.activeBlueprintId && this.selectedMat === mat;
      btn.className = `tw-brush-btn${isSelected ? ' is-selected' : ''}`;
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      btn.title = loc === 'ja' ? info.hintJa : info.hintEn;

      const labelSpan = document.createElement('span');
      labelSpan.textContent = info[loc];
      btn.appendChild(labelSpan);

      if (this.progression.mode === 'alchemist' && mat !== Mat.Air) {
        const badgeSpan = document.createElement('span');
        badgeSpan.className = 'tw-brush-stock';
        btn.appendChild(badgeSpan);
        this.stockBadgeEls.set(mat, { btn, badge: badgeSpan });
      }

      btn.addEventListener('click', () => {
        this.sound.unlock();
        this.selectedMat = mat;
        this.blueprints.activeBlueprintId = null;
        this.isCapturingBp = false;
        this.updateFloatingHint();
        this.refreshStaticUI();
      });
      brushRow.appendChild(btn);

      // 吸引/消去ツール (Mat.Air) と生成マテリアルの間に控えめな縦セパレータを置く
      if (mat === Mat.Air && paletteItems.length > 1) {
        const div = document.createElement('span');
        div.className = 'tw-divider-v';
        brushRow.appendChild(div);
      }
    }

    this.updatePaletteStocks();

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'tw-dock-controls';

    const leftCtrls = document.createElement('div');
    leftCtrls.className = 'tw-dock-left';

    // ブラシ径グループ
    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'tw-control-group';
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'tw-group-label';
    sizeLabel.textContent = t(loc, 'label_brush_size');
    const sizeSeg = document.createElement('div');
    sizeSeg.className = 'tw-seg';
    const sizes: { r: number; label: string }[] = [
      { r: 0, label: '1px' },
      { r: 2, label: 'S' },
      { r: 4, label: 'M' },
      { r: 7, label: 'L' },
    ];
    for (const s of sizes) {
      sizeSeg.appendChild(
        createUIButton({
          label: s.label,
          variant: 'segment',
          active: this.brushRadius === s.r,
          onClick: () => {
            this.brushRadius = s.r;
            this.refreshStaticUI();
          },
        })
      );
    }
    sizeGroup.append(sizeLabel, sizeSeg);

    // シミュレーション速度グループ（単色同線幅SVGアイコン）
    const speedGroup = document.createElement('div');
    speedGroup.className = 'tw-control-group';
    const speedLabel = document.createElement('span');
    speedLabel.className = 'tw-group-label';
    speedLabel.textContent = t(loc, 'label_sim_speed');
    const speedSeg = document.createElement('div');
    speedSeg.className = 'tw-seg';
    speedSeg.append(
      createUIButton({
        icon: 'pause',
        title: 'Pause (0x)',
        variant: 'segment',
        active: this.simSpeed === 0,
        onClick: () => {
          this.simSpeed = 0;
          this.refreshStaticUI();
        },
      }),
      createUIButton({
        icon: 'play',
        label: '1x',
        title: 'Normal Speed (1x)',
        variant: 'segment',
        active: this.simSpeed === 1,
        onClick: () => {
          this.simSpeed = 1;
          this.refreshStaticUI();
        },
      }),
      createUIButton({
        icon: 'fastForward',
        label: '2x',
        title: 'Fast Speed (2x)',
        variant: 'segment',
        active: this.simSpeed === 2,
        onClick: () => {
          this.simSpeed = 2;
          this.refreshStaticUI();
        },
      })
    );
    speedGroup.append(speedLabel, speedSeg);

    const activeInfo = MATERIAL_LABELS[this.selectedMat];
    const brushTip = document.createElement('span');
    brushTip.className = 'tw-brush-tooltip';
    brushTip.innerHTML = `<strong>${escapeHtml(activeInfo[loc])}</strong> — ${escapeHtml(
      loc === 'ja' ? activeInfo.hintJa : activeInfo.hintEn
    )}`;

    leftCtrls.append(sizeGroup, speedGroup, brushTip);

    const rightCtrls = document.createElement('div');
    rightCtrls.className = 'tw-dock-right';

    if (this.zoom > 1.01 || this.panX !== 0 || this.panY !== 0) {
      rightCtrls.appendChild(
        createUIButton({
          label: t(loc, 'btn_reset_view'),
          variant: 'ghost',
          onClick: () => {
            this.zoom = 1.0;
            this.panX = 0;
            this.panY = 0;
            this.refreshStaticUI();
          },
        })
      );
    }

    rightCtrls.append(
      createUIButton({
        label: t(loc, 'btn_new_world'),
        icon: 'refresh',
        variant: 'ghost',
        onClick: () => {
          this.startNewWorld(this.progression.mode);
        },
      }),
      createUIButton({
        label: t(loc, 'btn_snapshot'),
        icon: 'download',
        onClick: () => {
          void this.downloadEmbeddedPngSnapshot();
        },
      })
    );

    ctrlRow.append(leftCtrls, rightCtrls);
    this.dockEl.append(brushRow, ctrlRow);

    this.updateHeaderReadouts();
    this.updateSidebarDynamic();
  }

  /**
   * パレット各ボタンの所持ストック数値 / INF 表示のみを軽量に差分更新する
   */
  private updatePaletteStocks(): void {
    if (this.progression.mode !== 'alchemist') return;
    for (const [mat, refs] of this.stockBadgeEls) {
      const eff = this.progression.getEffectiveStock(mat);
      if (eff.infinite) {
        refs.badge.textContent = 'INF';
        refs.badge.className = 'tw-brush-stock is-inf';
        refs.btn.classList.remove('is-depleted');
      } else {
        refs.badge.textContent = `${eff.count}`;
        refs.badge.className = eff.count === 0 ? 'tw-brush-stock is-zero' : 'tw-brush-stock';
        refs.btn.classList.toggle('is-depleted', eff.count === 0);
      }
    }
  }

  private renderBlueprintItems(): void {
    this.bpListEl.innerHTML = '';
    for (const bp of this.blueprints.blueprints) {
      const isSelected = this.blueprints.activeBlueprintId === bp.id;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `tw-bp-item${isSelected ? ' is-selected' : ''}`;
      item.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      item.innerHTML = `<span>${escapeHtml(bp.name)}</span><span class="tw-bp-dim">${bp.width}×${bp.height}</span>`;
      item.addEventListener('click', () => {
        this.isCapturingBp = false;
        this.blueprints.activeBlueprintId = isSelected ? null : bp.id;
        this.updateFloatingHint();
        this.refreshStaticUI();
      });
      this.bpListEl.appendChild(item);
    }
  }

  private openLoadCodeModal(): void {
    const loc = this.locale;
    this.modal.open({
      title: t(loc, 'modal_code_title'),
      placeholder: t(loc, 'modal_code_placeholder'),
      confirmLabel: t(loc, 'modal_confirm'),
      cancelLabel: t(loc, 'modal_cancel'),
      onConfirm: (code) => {
        const ok = deserializeWorld(code, this.world, this.progression);
        if (ok) {
          this.sprites.clear();
          this.storyteller.reset();
          if (this.progression.mode === 'alchemist') {
            this.world.saveDawnSnapshot();
            this.progression.saveDawnState();
          }
          this.showToast(t(this.locale, 'toast_loaded'), 'default');
          this.refreshStaticUI();
        } else {
          this.showToast(t(this.locale, 'toast_load_err'), 'error');
        }
      },
    });
  }

  private updateFloatingHint(): void {
    if (this.transientHintTimer !== null) {
      window.clearTimeout(this.transientHintTimer);
      this.transientHintTimer = null;
    }
    if (this.isCapturingBp) {
      this.floatingHintEl.textContent = t(this.locale, 'bp_capturing_hint');
      this.floatingHintEl.hidden = false;
    } else {
      this.floatingHintEl.hidden = true;
    }
  }

  private showTransientHint(msg: string): void {
    if (this.isCapturingBp) return;
    this.floatingHintEl.textContent = msg;
    this.floatingHintEl.hidden = false;
    if (this.transientHintTimer !== null) {
      window.clearTimeout(this.transientHintTimer);
    }
    this.transientHintTimer = window.setTimeout(() => {
      this.transientHintTimer = null;
      if (!this.isCapturingBp) {
        this.floatingHintEl.hidden = true;
      }
    }, 1600);
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (e) => {
      if (this.modal.isOpen()) {
        if (e.key === 'Escape') this.modal.close(false);
        return;
      }
      if (this.collapseModal.isOpen()) {
        return;
      }
      if (e.code === 'Space') {
        this.isSpaceDown = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpaceDown = false;
        this.isPanning = false;
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('pointerenter', () => {
      this.isPointerInside = true;
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.isPointerInside = false;
      this.isDrawing = false;
      this.isPanning = false;
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.isAnyModalOpen()) return;
      this.sound.unlock();
      this.canvas.setPointerCapture(e.pointerId);
      const pos = this.clientToGrid(e.clientX, e.clientY);
      this.hoverX = pos.x;
      this.hoverY = pos.y;
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;

      if (e.button === 1 || (e.button === 0 && this.isSpaceDown)) {
        this.isPanning = true;
        return;
      }

      if (this.isCapturingBp && e.button === 0) {
        this.bpDragStart = { x: pos.x, y: pos.y };
        return;
      }

      const activeBp = this.blueprints.getActive();
      if (activeBp && e.button === 0) {
        const placed = this.blueprints.stamp(
          this.world,
          activeBp,
          pos.x,
          pos.y,
          this.progression
        );
        if (placed > 0) {
          this.sound.playChime('deliver');
          this.updatePaletteStocks();
        } else if (this.progression.mode === 'alchemist') {
          this.showTransientHint(t(this.locale, 'hint_out_of_stock'));
        }
        return;
      }

      this.isDrawing = true;
      this.drawButton = e.button;
      this.paintAt(pos.x, pos.y);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const pos = this.clientToGrid(e.clientX, e.clientY);

      if (this.isPanning) {
        const rect = this.canvas.getBoundingClientRect();
        const dx = ((e.clientX - this.lastClientX) / rect.width) * WIDTH;
        const dy = ((e.clientY - this.lastClientY) / rect.height) * HEIGHT;
        this.panX = this.clampPan(this.panX - dx / this.zoom, WIDTH);
        this.panY = this.clampPan(this.panY - dy / this.zoom, HEIGHT);
        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;
        return;
      }

      if (this.isDrawing) {
        this.paintLine(this.hoverX, this.hoverY, pos.x, pos.y);
      }

      this.hoverX = pos.x;
      this.hoverY = pos.y;
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (this.isCapturingBp && this.bpDragStart) {
        const start = this.bpDragStart;
        const end = this.clientToGrid(e.clientX, e.clientY);
        this.bpDragStart = null;
        this.isCapturingBp = false;
        this.updateFloatingHint();

        const w = Math.abs(end.x - start.x) + 1;
        const h = Math.abs(end.y - start.y) + 1;
        if (w >= 2 && h >= 2) {
          const loc = this.locale;
          const defaultName = `Module ${this.blueprints.blueprints.length + 1}`;
          this.modal.open({
            title: t(loc, 'modal_bp_title'),
            placeholder: t(loc, 'modal_bp_placeholder'),
            defaultValue: defaultName,
            confirmLabel: t(loc, 'modal_confirm'),
            cancelLabel: t(loc, 'modal_cancel'),
            onConfirm: (name) => {
              const bp = this.blueprints.captureRegion(
                this.world,
                start.x,
                start.y,
                end.x,
                end.y,
                name
              );
              if (bp) {
                this.blueprints.activeBlueprintId = bp.id;
                this.showToast(t(this.locale, 'toast_bp_saved'), 'default');
              }
              this.refreshStaticUI();
            },
            onCancel: () => {
              this.refreshStaticUI();
            },
          });
        } else {
          this.refreshStaticUI();
        }
      }
      this.isDrawing = false;
      this.isPanning = false;
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const prevZoom = this.zoom;
        this.zoom = Math.max(1.0, Math.min(4.0, this.zoom * factor));
        if (this.zoom === 1.0) {
          this.panX = 0;
          this.panY = 0;
        } else if (prevZoom !== this.zoom) {
          this.panX = this.clampPan(this.panX, WIDTH);
          this.panY = this.clampPan(this.panY, HEIGHT);
        }
        if ((prevZoom === 1.0) !== (this.zoom === 1.0)) {
          this.refreshStaticUI();
        }
      },
      { passive: false }
    );

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropOverlayEl.classList.add('active');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) {
        this.dropOverlayEl.classList.remove('active');
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropOverlayEl.classList.remove('active');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type === 'image/png') {
        void this.importWorldFromPngFile(file);
      }
    });
  }

  private clampPan(pan: number, fullSize: number): number {
    const viewSize = fullSize / this.zoom;
    return Math.max(0, Math.min(fullSize - viewSize, pan));
  }

  private clientToGrid(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const u = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(0.9999, (clientY - rect.top) / rect.height));
    const viewW = WIDTH / this.zoom;
    const viewH = HEIGHT / this.zoom;
    const gx = Math.floor(this.panX + u * viewW);
    const gy = Math.floor(this.panY + v * viewH);
    return {
      x: Math.max(0, Math.min(WIDTH - 1, gx)),
      y: Math.max(0, Math.min(HEIGHT - 1, gy)),
    };
  }

  private paintLine(x0: number, y0: number, x1: number, y1: number): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const gx = Math.round(x0 + ((x1 - x0) * s) / steps);
      const gy = Math.round(y0 + ((y1 - y0) * s) / steps);
      this.paintAt(gx, gy);
    }
  }

  private paintAt(gx: number, gy: number): void {
    const isHarvest = this.drawButton === 2 || this.selectedMat === Mat.Air;
    const res = applyHybridBrush(
      this.world,
      this.progression,
      gx,
      gy,
      this.brushRadius,
      this.selectedMat,
      isHarvest ? 'harvest' : 'place'
    );

    if (res.changedCount > 0) {
      if (isHarvest && this.progression.mode === 'alchemist') {
        this.sound.playHarvestSound();
      } else {
        this.sound.playBrushSound(isHarvest ? Mat.Air : this.selectedMat);
      }
      if (this.progression.mode === 'alchemist') {
        this.updatePaletteStocks();
      }
    }

    if (res.blockedTier > 0) {
      this.blockedCursorUntil = performance.now() + 650;
      this.sound.playHardnessBlocked();
      this.showTransientHint(
        t(this.locale, res.blockedTier >= 3 ? 'hint_req_tier_3' : 'hint_req_tier_2')
      );
    } else if (res.outOfStock && res.changedCount === 0) {
      this.blockedCursorUntil = performance.now() + 500;
      this.showTransientHint(t(this.locale, 'hint_out_of_stock'));
    }
  }

  /**
   * メインの 60FPS シミュレーション＆レンダリングループ
   */
  private loop = (): void => {
    const prevAntenna = this.storyteller.lastStats.hasActiveAntenna;

    for (let step = 0; step < this.simSpeed; step++) {
      stepSimulation(this.world);
      stepPowerAndMachines(this.world);
      if ((this.world.tick & 7) === 0) {
        stepProceduralDecor(this.world);
      }
      this.sprites.update(this.world);
      this.storyteller.update(this.world, this.sprites, this.progression);
      if (this.collapseModal.isOpen()) break;
    }

    // 天候アンテナが新たに設置された場合はヘッダー制御スイッチを即座に有効化
    if (!prevAntenna && this.storyteller.lastStats.hasActiveAntenna) {
      this.refreshStaticUI();
    }

    if (this.world.tick % 15 === 0) {
      const rainFactor = this.storyteller.currentWeather === 'monsoon' ? 1.0 : 0.08;
      this.sound.updateAmbient(rainFactor, this.world.isNight());
    }

    this.renderFrame();

    this.frameCounter++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 500) {
      this.fps = Math.round((this.frameCounter * 1000) / (now - this.lastFpsTime));
      this.frameCounter = 0;
      this.lastFpsTime = now;
      const fpsEl = document.getElementById('tw-fps');
      if (fpsEl) fpsEl.textContent = `${this.fps} FPS`;
    }
    if ((this.frameCounter & 7) === 0) {
      this.updateHeaderReadouts();
      this.updateSidebarDynamic();
      this.updatePaletteStocks();
    }

    requestAnimationFrame(this.loop);
  };

  private renderFrame(): void {
    const showGuard =
      this.progression.mode === 'alchemist' &&
      this.isPointerInside &&
      this.selectedMat !== Mat.Air;

    this.renderer.renderPixels(this.world, showGuard);
    this.sprites.render(this.renderer.offCtx, this.world);

    if ((this.world.tick & 1) === 0) {
      const extraLights = this.sprites.getLightSources(this.world);
      this.lighting.updateGlowMap(this.world, extraLights);
    }

    const viewW = WIDTH / this.zoom;
    const viewH = HEIGHT / this.zoom;

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.renderer.offscreen,
      this.panX,
      this.panY,
      viewW,
      viewH,
      0,
      0,
      DISPLAY_W,
      DISPLAY_H
    );

    this.ctx.globalCompositeOperation = 'screen';
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(
      this.lighting.glowCanvas,
      this.panX / 4,
      this.panY / 4,
      viewW / 4,
      viewH / 4,
      0,
      0,
      DISPLAY_W,
      DISPLAY_H
    );
    this.ctx.restore();

    if (this.isPointerInside && !this.isAnyModalOpen()) {
      this.renderCursorOverlay(viewW, viewH);
    }
  }

  private renderCursorOverlay(viewW: number, viewH: number): void {
    const toScreenX = (gx: number) => ((gx - this.panX) / viewW) * DISPLAY_W;
    const toScreenY = (gy: number) => ((gy - this.panY) / viewH) * DISPLAY_H;
    const cellScreenW = DISPLAY_W / viewW;
    const cellScreenH = DISPLAY_H / viewH;

    this.ctx.save();

    if (this.isCapturingBp && this.bpDragStart) {
      const minX = Math.min(this.bpDragStart.x, this.hoverX);
      const maxX = Math.max(this.bpDragStart.x, this.hoverX);
      const minY = Math.min(this.bpDragStart.y, this.hoverY);
      const maxY = Math.max(this.bpDragStart.y, this.hoverY);
      this.ctx.strokeStyle = TOKEN_COLOR_WARNING;
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([4, 4]);
      this.ctx.strokeRect(
        toScreenX(minX),
        toScreenY(minY),
        (maxX - minX + 1) * cellScreenW,
        (maxY - minY + 1) * cellScreenH
      );
      this.ctx.restore();
      return;
    }

    const activeBp = this.blueprints.getActive();
    if (activeBp) {
      const sx = this.hoverX - (activeBp.width >> 1);
      const sy = this.hoverY - (activeBp.height >> 1);
      this.ctx.strokeStyle = TOKEN_COLOR_ACCENT;
      this.ctx.lineWidth = 1.5;
      const rx = toScreenX(sx);
      const ry = toScreenY(sy);
      const rw = activeBp.width * cellScreenW;
      const rh = activeBp.height * cellScreenH;
      this.ctx.strokeRect(rx, ry, rw, rh);
      this.ctx.restore();
      return;
    }

    const cx = toScreenX(this.hoverX + 0.5);
    const cy = toScreenY(this.hoverY + 0.5);
    const effRadius =
      this.progression.mode === 'alchemist' &&
      this.progression.toolTier === 1 &&
      (this.drawButton === 2 || this.selectedMat === Mat.Air)
        ? Math.min(this.brushRadius, 3)
        : this.brushRadius;
    const rPx = Math.max(cellScreenW * 0.5, (effRadius + 0.5) * cellScreenW);
    const isBlockedNow = performance.now() < this.blockedCursorUntil;
    this.ctx.strokeStyle = isBlockedNow ? TOKEN_COLOR_WARNING : TOKEN_COLOR_TEXT_PRIMARY;
    this.ctx.lineWidth = isBlockedNow ? 1.5 : 1;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private updateHeaderReadouts(): void {
    const loc = this.locale;
    const tod = this.world.timeOfDay;
    const isNight = this.world.isNight();
    const phaseKey: DictKey =
      tod < 0.2 || tod >= 0.82
        ? 'time_night'
        : tod < 0.35
          ? 'time_morning'
          : tod < 0.68
            ? 'time_noon'
            : 'time_evening';

    this.timeReadoutEl.textContent = `${t(loc, 'day_prefix')} ${this.world.dayCount} · ${t(loc, phaseKey)}`;
    const isRaidNight =
      this.progression.mode === 'alchemist' && this.progression.raidsEnabled && isNight;

    this.timeReadoutEl.className = isRaidNight
      ? this.storyteller.isEclipseNight
        ? 'tw-readout-item is-danger'
        : 'tw-readout-item is-warning'
      : 'tw-readout-item';

    this.readoutStripEl.className = isRaidNight
      ? this.storyteller.isEclipseNight
        ? 'tw-readout-strip is-eclipse'
        : 'tw-readout-strip is-raid'
      : 'tw-readout-strip';

    const wKey = `weather_${this.storyteller.currentWeather}` as DictKey;
    this.weatherReadoutEl.textContent = t(loc, wKey);
    this.weatherReadoutEl.className =
      this.storyteller.currentWeather !== 'clear'
        ? 'tw-readout-item is-warning'
        : 'tw-readout-muted';

    if (
      this.progression.mode === 'alchemist' &&
      this.vitalityStripEl &&
      this.tierBadgeEl &&
      this.vitalityFillEl &&
      this.vitalityNumEl
    ) {
      const vit = Math.max(0, Math.min(100, Math.round(this.world.coreVitality)));
      const recentlyHit = performance.now() - this.lastCoreHitAt < 900;
      const isDanger = vit <= 35 || recentlyHit;

      this.tierBadgeEl.textContent = `Tier ${this.progression.toolTier}`;
      this.vitalityFillEl.style.width = `${vit}%`;
      this.vitalityFillEl.className = isDanger ? 'tw-vitality-fill is-danger' : 'tw-vitality-fill';
      this.vitalityNumEl.textContent = `${vit}%`;
      this.vitalityNumEl.className = isDanger ? 'tw-vitality-num is-danger' : 'tw-vitality-num';
      this.vitalityStripEl.className = isDanger
        ? 'tw-vitality-strip is-critical'
        : 'tw-vitality-strip';
    }
  }

  private updateSidebarDynamic(): void {
    const loc = this.locale;

    // 1. 目標 / 観測ノート更新
    if (this.progression.mode === 'cozy') {
      this.goalBodyEl.innerHTML = `
        <ul class="tw-notes-list">
          <li>${escapeHtml(t(loc, 'cozy_tip_1'))}</li>
          <li>${escapeHtml(t(loc, 'cozy_tip_2'))}</li>
          <li>${escapeHtml(t(loc, 'cozy_tip_3'))}</li>
          <li>${escapeHtml(t(loc, 'cozy_tip_4'))}</li>
        </ul>
      `;
    } else {
      const ms = this.progression.getCurrentMilestoneView(this.world.dayCount);
      if (!ms) {
        this.goalBodyEl.innerHTML = `<p class="tw-status-complete">${escapeHtml(t(loc, 'tier_4_done'))}</p>`;
      } else {
        const rows = ms.bars
          .map((b) => {
            const pct = Math.min(100, Math.round((b.current / b.target) * 100));
            const label = escapeHtml(t(loc, b.labelKey as DictKey));
            return `
              <div class="tw-progress-row">
                <div class="tw-progress-label"><span>${label}</span><span>${b.current} / ${b.target}</span></div>
                <div class="tw-progress-bar"><div class="tw-progress-fill" style="width:${pct}%"></div></div>
              </div>
            `;
          })
          .join('');
        const unlocks = ms.nextUnlockMats
          .map((m) => escapeHtml(MATERIAL_LABELS[m][loc]))
          .join(', ');
        this.goalBodyEl.innerHTML = `
          <div class="tw-stage-title">${escapeHtml(t(loc, ms.titleKey as DictKey))}</div>
          <p class="tw-body-text">${escapeHtml(t(loc, ms.descKey as DictKey))}</p>
          <div class="tw-progress-group">${rows}</div>
          <p class="tw-law-note">${escapeHtml(t(loc, ms.lawKey as DictKey))}</p>
          <p class="tw-unlock-note">${escapeHtml(t(loc, 'next_unlock'))} <strong>${unlocks}</strong></p>
        `;
      }
    }

    // 2. セル観測値 (Inspector) 更新
    const idx = this.world.idx(this.hoverX, this.hoverY);
    const mat = this.world.type[idx] as MatId;
    const bg = this.world.bgType[idx];
    const flags = this.world.flags[idx];
    const matLabel = MATERIAL_LABELS[mat];
    const bgKey: DictKey =
      bg === BgMat.WoodPillar
        ? 'bg_pillar'
        : bg === BgMat.WoodArch
          ? 'bg_arch'
          : bg === BgMat.StoneWall
            ? 'bg_stone'
            : bg === BgMat.RotorBlade
              ? 'bg_rotor'
              : bg === BgMat.CoreTree
                ? 'bg_core'
                : 'bg_none';

    const tileText = mat === Mat.Air ? t(loc, 'insp_air') : matLabel[loc];
    const hVal = MAT_HARDNESS[mat];
    let hardnessText = `H${hVal}`;
    let hardnessWarn = false;
    if (mat !== Mat.Air) {
      if ((flags & FLAG_INDESTRUCTIBLE) !== 0) {
        hardnessText = t(loc, 'hardness_indestructible');
      } else if (
        this.progression.mode === 'alchemist' &&
        (flags & FLAG_RUIN) !== 0 &&
        this.progression.toolTier < 3
      ) {
        hardnessText = t(loc, 'hardness_ruin_locked');
        hardnessWarn = true;
      } else if (this.progression.mode === 'alchemist' && hVal > this.progression.toolTier) {
        hardnessText = `H${hVal} (${t(loc, 'hardness_req_prefix')} ${hVal})`;
        hardnessWarn = true;
      } else {
        hardnessText = `H${hVal} (${t(loc, 'hardness_ok')})`;
      }
    }

    this.inspectorBodyEl.innerHTML = `
      <span>${escapeHtml(t(loc, 'insp_pos'))}</span><span>${this.hoverX}, ${this.hoverY}</span>
      <span>${escapeHtml(t(loc, 'insp_tile'))}</span><span>${escapeHtml(tileText)}</span>
      <span>${escapeHtml(t(loc, 'insp_bg'))}</span><span>${escapeHtml(t(loc, bgKey))}</span>
      <span>${escapeHtml(t(loc, 'insp_hardness'))}</span><span${hardnessWarn ? ' class="tw-val-warning"' : ''}>${escapeHtml(hardnessText)}</span>
      <span>${escapeHtml(t(loc, 'insp_temp'))}</span><span>${this.world.temp[idx]} °C</span>
      <span>${escapeHtml(t(loc, 'insp_charge'))}</span><span>${this.world.charge[idx]} V / ${this.world.meta[idx]}</span>
    `;

    // 3. スプライト個体数更新
    const counts = this.sprites.countByKind();
    this.spriteBodyEl.innerHTML = `
      <span>${escapeHtml(t(loc, 'sprite_aqua'))}</span><span>${counts.aqua_puff}</span>
      <span>${escapeHtml(t(loc, 'sprite_root'))}</span><span>${counts.root_roller}</span>
      <span>${escapeHtml(t(loc, 'sprite_spark'))}</span><span>${counts.spark_bit}</span>
      <span>${escapeHtml(t(loc, 'sprite_mite'))}</span><span${counts.shade_mite > 0 ? ' class="tw-val-warning"' : ''}>${counts.shade_mite}</span>
    `;
  }

  private async copyShareUrl(): Promise<void> {
    const code = serializeWorld(this.world, this.progression);
    const url = `${window.location.origin}${window.location.pathname}#world=${code}`;
    window.history.replaceState(null, '', `#world=${code}`);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // クリップボード権限がない環境ではURLハッシュ更新のみ完了
    }
    this.showToast(t(this.locale, 'toast_copied'), 'default');
  }

  private async downloadEmbeddedPngSnapshot(): Promise<void> {
    const blob = await new Promise<Blob | null>((resolve) =>
      this.canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) return;

    const rawBytes = new Uint8Array(await blob.arrayBuffer());
    const code = serializeWorld(this.world, this.progression);
    const embeddedBytes = embedWorldIntoPng(rawBytes, code);

    const outBlob = new Blob([embeddedBytes.buffer as ArrayBuffer], { type: 'image/png' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(outBlob);
    a.download = `terra-weave-day${this.world.dayCount}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.showToast(t(this.locale, 'toast_png_saved'), 'default');
  }

  private async importWorldFromPngFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const code = extractWorldFromPng(bytes);
    if (code && deserializeWorld(code, this.world, this.progression)) {
      this.sprites.clear();
      this.storyteller.reset();
      if (this.progression.mode === 'alchemist') {
        this.world.saveDawnSnapshot();
        this.progression.saveDawnState();
      }
      this.showToast(t(this.locale, 'toast_loaded'), 'default');
      this.refreshStaticUI();
    } else {
      this.showToast(t(this.locale, 'toast_load_err'), 'error');
    }
  }

  private showToast(msg: string, tone: 'default' | 'warning' | 'error' = 'default'): void {
    this.toastEl.textContent = msg;
    this.toastEl.className = 'tw-toast visible';
    if (tone === 'warning') this.toastEl.classList.add('is-warning');
    if (tone === 'error') this.toastEl.classList.add('is-error');

    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('visible');
    }, 3400);
  }
}
