import { SoundEngine } from '../audio/soundEngine';
import { BgMat, Mat, MatId } from '../core/materials';
import { stepSimulation } from '../core/simulation';
import { GameMode, generateTerrain } from '../core/terrainGen';
import { HEIGHT, WIDTH, WorldGrid } from '../core/world';
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
import { createUIButton, escapeHtml, InputModalController } from './components';
import { DictKey, Locale, MATERIAL_LABELS, t } from './i18n';
import { applyBrush } from './viewport';

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

  locale: Locale = 'ja';
  selectedMat: MatId = Mat.Water;
  brushRadius: number = 2; // 0: 1px, 2: S, 4: M, 7: L
  simSpeed: 0 | 1 | 2 = 1;

  // ビューポート（ズーム＆パン）
  zoom: number = 1.0;
  panX: number = 0;
  panY: number = 0;

  // マウス入力状態
  private hoverX: number = 128;
  private hoverY: number = 72;
  private isPointerInside: boolean = false;
  private isDrawing: boolean = false;
  private drawButton: number = 0;
  private isPanning: boolean = false;
  private isSpaceDown: boolean = false;
  private lastClientX: number = 0;
  private lastClientY: number = 0;

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
  private timeReadoutEl!: HTMLElement;
  private weatherReadoutEl!: HTMLElement;
  private goalBodyEl!: HTMLElement;
  private inspectorBodyEl!: HTMLElement;
  private spriteBodyEl!: HTMLElement;
  private bpListEl!: HTMLElement;

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

  private setupCoreCallbacks(): void {
    this.world.onCoreDeliver = (kind, amount) => {
      this.progression.recordDelivery(kind, amount);
    };

    this.progression.onDeliver = () => {
      this.sound.playChime('deliver');
    };

    this.progression.onStageUnlocked = (_stage, unlocked) => {
      this.sound.playChime('unlock');
      const names = unlocked.map((m) => MATERIAL_LABELS[m][this.locale]).join(', ');
      this.showToast(`${t(this.locale, 'toast_unlocked')} ${names}`, 'default');
      this.refreshStaticUI();
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

  private initInitialWorld(): void {
    if (window.location.hash.startsWith('#world=')) {
      const ok = deserializeWorld(window.location.hash, this.world, this.progression);
      if (ok) {
        this.sprites.clear();
        return;
      }
    }
    this.startNewWorld('cozy', 20261029);
  }

  startNewWorld(mode: GameMode, seed?: number): void {
    const nextSeed = seed ?? ((Math.random() * 0x7fffffff) | 0);
    this.progression.reset(mode);
    this.storyteller.reset();
    this.sprites.clear();
    generateTerrain(this.world, mode, nextSeed);

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

    this.root.append(this.headerEl, workspace, this.dockEl, this.modal.backdropEl);
  }

  /**
   * モード切替・アンロック・言語切替時にUI全体を再構築する
   */
  refreshStaticUI(): void {
    const loc = this.locale;
    this.dropOverlayEl.textContent = t(loc, 'drop_overlay');

    // 1. トップ観測機器バー (HUD Header)
    this.headerEl.innerHTML = '';

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

    const readoutStrip = document.createElement('div');
    readoutStrip.className = 'tw-readout-strip';
    this.timeReadoutEl = document.createElement('span');
    this.timeReadoutEl.className = 'tw-readout-item';
    const sep = document.createElement('span');
    sep.className = 'tw-divider-v';
    this.weatherReadoutEl = document.createElement('span');
    this.weatherReadoutEl.className = 'tw-readout-item';
    readoutStrip.append(this.timeReadoutEl, sep, this.weatherReadoutEl);

    center.append(modeSeg, readoutStrip);

    // Cozy Mode または 天候アンテナ解放時は矩形セグメントの天候トリガーを表示（絵文字不使用）
    if (
      this.progression.mode === 'cozy' ||
      this.progression.stage > 5 ||
      this.storyteller.lastStats.hasActiveAntenna
    ) {
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
    const brushRow = document.createElement('div');
    brushRow.className = 'tw-brushes';

    const available = this.progression.getAvailableBrushes();
    for (let i = 0; i < available.length; i++) {
      const mat = available[i];
      const info = MATERIAL_LABELS[mat];
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = !this.blueprints.activeBlueprintId && this.selectedMat === mat;
      btn.className = `tw-brush-btn${isSelected ? ' is-selected' : ''}`;
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      btn.textContent = info[loc];
      btn.title = loc === 'ja' ? info.hintJa : info.hintEn;
      btn.addEventListener('click', () => {
        this.sound.unlock();
        this.selectedMat = mat;
        this.blueprints.activeBlueprintId = null;
        this.isCapturingBp = false;
        this.updateFloatingHint();
        this.refreshStaticUI();
      });
      brushRow.appendChild(btn);

      // 消去ツール (Mat.Air) と生成マテリアルの間に控えめな縦セパレータを置く
      if (mat === Mat.Air && available.length > 1) {
        const div = document.createElement('span');
        div.className = 'tw-divider-v';
        brushRow.appendChild(div);
      }
    }

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
          this.showToast(t(this.locale, 'toast_loaded'), 'default');
          this.refreshStaticUI();
        } else {
          this.showToast(t(this.locale, 'toast_load_err'), 'error');
        }
      },
    });
  }

  private updateFloatingHint(): void {
    if (this.isCapturingBp) {
      this.floatingHintEl.textContent = t(this.locale, 'bp_capturing_hint');
      this.floatingHintEl.hidden = false;
    } else {
      this.floatingHintEl.hidden = true;
    }
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (e) => {
      if (this.modal.isOpen()) {
        if (e.key === 'Escape') this.modal.close(false);
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
      if (this.modal.isOpen()) return;
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
    const matToUse = this.drawButton === 2 ? Mat.Air : this.selectedMat;
    const count = applyBrush(
      this.world,
      gx,
      gy,
      this.brushRadius,
      matToUse,
      this.progression.mode === 'alchemist'
    );
    if (count > 0) {
      this.sound.playBrushSound(matToUse);
    }
  }

  /**
   * メインの 60FPS シミュレーション＆レンダリングループ
   */
  private loop = (): void => {
    for (let step = 0; step < this.simSpeed; step++) {
      stepSimulation(this.world);
      stepPowerAndMachines(this.world);
      if ((this.world.tick & 7) === 0) {
        stepProceduralDecor(this.world);
      }
      this.sprites.update(this.world);
      this.storyteller.update(this.world, this.sprites, this.progression);
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

    if (this.isPointerInside && !this.modal.isOpen()) {
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
    const rPx = Math.max(cellScreenW * 0.5, (this.brushRadius + 0.5) * cellScreenW);
    this.ctx.strokeStyle = TOKEN_COLOR_TEXT_PRIMARY;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private updateHeaderReadouts(): void {
    const loc = this.locale;
    const tod = this.world.timeOfDay;
    const phaseKey: DictKey =
      tod < 0.2 || tod >= 0.82
        ? 'time_night'
        : tod < 0.35
          ? 'time_morning'
          : tod < 0.68
            ? 'time_noon'
            : 'time_evening';

    this.timeReadoutEl.textContent = `${t(loc, 'day_prefix')} ${this.world.dayCount} · ${t(loc, phaseKey)}`;

    const wKey = `weather_${this.storyteller.currentWeather}` as DictKey;
    this.weatherReadoutEl.textContent = t(loc, wKey);
    this.weatherReadoutEl.className =
      this.storyteller.currentWeather !== 'clear'
        ? 'tw-readout-item is-warning'
        : 'tw-readout-muted';
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
      const st = this.progression.getCurrentStageDef();
      if (!st) {
        this.goalBodyEl.innerHTML = `<p class="tw-status-complete">${escapeHtml(t(loc, 'all_stages_done'))}</p>`;
      } else {
        const rows = st.requirements
          .map((req) => {
            const cur = this.progression.progress[req.kind];
            const pct = Math.min(100, Math.round((cur / req.target) * 100));
            const label = escapeHtml(t(loc, `req_${req.kind}` as DictKey));
            return `
              <div class="tw-progress-row">
                <div class="tw-progress-label"><span>${label}</span><span>${cur} / ${req.target}</span></div>
                <div class="tw-progress-bar"><div class="tw-progress-fill" style="width:${pct}%"></div></div>
              </div>
            `;
          })
          .join('');
        const unlocks = st.unlockedBrushes
          .map((m) => escapeHtml(MATERIAL_LABELS[m][loc]))
          .join(', ');
        this.goalBodyEl.innerHTML = `
          <div class="tw-stage-title">${escapeHtml(t(loc, st.titleKey as DictKey))}</div>
          <p class="tw-body-text">${escapeHtml(t(loc, st.descKey as DictKey))}</p>
          <div class="tw-progress-group">${rows}</div>
          <p class="tw-unlock-note">${escapeHtml(t(loc, 'next_unlock'))} <strong>${unlocks}</strong></p>
        `;
      }
    }

    // 2. セル観測値 (Inspector) 更新
    const idx = this.world.idx(this.hoverX, this.hoverY);
    const mat = this.world.type[idx] as MatId;
    const bg = this.world.bgType[idx];
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

    this.inspectorBodyEl.innerHTML = `
      <span>${escapeHtml(t(loc, 'insp_pos'))}</span><span>${this.hoverX}, ${this.hoverY}</span>
      <span>${escapeHtml(t(loc, 'insp_tile'))}</span><span>${escapeHtml(tileText)}</span>
      <span>${escapeHtml(t(loc, 'insp_bg'))}</span><span>${escapeHtml(t(loc, bgKey))}</span>
      <span>${escapeHtml(t(loc, 'insp_temp'))}</span><span>${this.world.temp[idx]} °C</span>
      <span>${escapeHtml(t(loc, 'insp_charge'))}</span><span>${this.world.charge[idx]} V / ${this.world.meta[idx]}</span>
    `;

    // 3. スプライト個体数更新
    const counts = this.sprites.countByKind();
    this.spriteBodyEl.innerHTML = `
      <span>${escapeHtml(t(loc, 'sprite_aqua'))}</span><span>${counts.aqua_puff}</span>
      <span>${escapeHtml(t(loc, 'sprite_root'))}</span><span>${counts.root_roller}</span>
      <span>${escapeHtml(t(loc, 'sprite_spark'))}</span><span>${counts.spark_bit}</span>
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
