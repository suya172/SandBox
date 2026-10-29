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
import { DictKey, Locale, MATERIAL_LABELS, t } from './i18n';
import { applyBrush } from './viewport';

const DISPLAY_SCALE = 4;
const DISPLAY_W = WIDTH * DISPLAY_SCALE;   // 1024
const DISPLAY_H = HEIGHT * DISPLAY_SCALE;  // 576

/**
 * TERRA-WEAVE アプリケーション統合コントローラ & UI (Phase 4)
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

  locale: Locale = 'ja';
  selectedMat: MatId = Mat.Water;
  brushRadius: number = 2; // 0: 小(1px), 2: 中, 5: 大
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
  private timeBadgeEl!: HTMLElement;
  private weatherBadgeEl!: HTMLElement;
  private goalBodyEl!: HTMLElement;
  private inspectorBodyEl!: HTMLElement;
  private spriteBodyEl!: HTMLElement;
  private bpListEl!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.setupCoreCallbacks();
    this.buildLayout();
    this.initInitialWorld();
    this.bindEvents();
    this.refreshStaticUI();
    requestAnimationFrame(this.loop);
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
      const names = unlocked
        .map((m) => `${MATERIAL_LABELS[m].icon}${MATERIAL_LABELS[m][this.locale]}`)
        .join(' / ');
      this.showToast(`${t(this.locale, 'toast_unlocked')} ${names}`);
      this.refreshStaticUI();
    };

    this.storyteller.onWeatherChange = (weather) => {
      if (weather !== 'clear') {
        this.sound.playChime('weather');
        const key = `weather_${weather}` as DictKey;
        this.showToast(`${t(this.locale, 'toast_weather')} ${t(this.locale, key)}`);
      }
      this.updateHeaderBadges();
    };
  }

  private initInitialWorld(): void {
    // URLハッシュ (#world=...) があればサーバーレス復元を試みる
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
    this.floatingHintEl.style.display = 'none';

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

    this.root.append(this.headerEl, workspace, this.dockEl);
  }

  /**
   * モード切替・アンロック・言語切替時にUI全体を再描画する
   */
  refreshStaticUI(): void {
    const loc = this.locale;
    this.dropOverlayEl.textContent = t(loc, 'drop_overlay');

    // 1. ヘッダー構築
    this.headerEl.innerHTML = '';
    const brand = document.createElement('div');
    brand.className = 'tw-brand';
    brand.innerHTML = `<span>🌱 TERRA-WEAVE</span><span class="tw-brand-sub">256×144 Eco-Automata</span>`;

    const center = document.createElement('div');
    center.className = 'tw-header-center';

    const modeSeg = document.createElement('div');
    modeSeg.className = 'tw-seg';
    const btnCozy = this.makeBtn(t(loc, 'mode_cozy'), this.progression.mode === 'cozy', () => {
      if (this.progression.mode !== 'cozy') this.startNewWorld('cozy');
    });
    const btnAlch = this.makeBtn(t(loc, 'mode_alchemist'), this.progression.mode === 'alchemist', () => {
      if (this.progression.mode !== 'alchemist') this.startNewWorld('alchemist');
    });
    modeSeg.append(btnCozy, btnAlch);

    this.timeBadgeEl = document.createElement('span');
    this.timeBadgeEl.className = 'tw-badge';
    this.weatherBadgeEl = document.createElement('span');
    this.weatherBadgeEl.className = 'tw-badge';

    center.append(modeSeg, this.timeBadgeEl, this.weatherBadgeEl);

    // Cozy Mode または 天候制御アンテナ解放時はワンクリック天候切替を表示
    if (this.progression.mode === 'cozy' || this.progression.stage > 5 || this.storyteller.lastStats.hasActiveAntenna) {
      const wSeg = document.createElement('div');
      wSeg.className = 'tw-seg';
      const weathers: { k: WeatherKind; icon: string }[] = [
        { k: 'clear', icon: '☀️' },
        { k: 'monsoon', icon: '🌧️' },
        { k: 'heatwave', icon: '🔥' },
        { k: 'starfall', icon: '🌠' },
      ];
      for (const w of weathers) {
        const wb = this.makeBtn(w.icon, this.storyteller.currentWeather === w.k, () => {
          this.storyteller.triggerWeather(w.k, 960);
          this.refreshStaticUI();
        });
        wb.title = t(loc, `weather_${w.k}` as DictKey);
        wSeg.appendChild(wb);
      }
      center.appendChild(wSeg);
    }

    const right = document.createElement('div');
    right.className = 'tw-header-right';

    const btnLang = this.makeBtn(loc === 'ja' ? '🌐 日本語 / EN' : '🌐 EN / 日本語', false, () => {
      this.locale = this.locale === 'ja' ? 'en' : 'ja';
      this.refreshStaticUI();
    });
    btnLang.className = 'tw-btn';

    const btnMute = this.makeBtn(this.sound.isMuted() ? '🔇' : '🔊', !this.sound.isMuted(), () => {
      this.sound.unlock();
      this.sound.toggleMute();
      this.refreshStaticUI();
    });
    btnMute.className = 'tw-btn';

    right.append(btnLang, btnMute);
    this.headerEl.append(brand, center, right);

    // 2. 右サイドパネル構築
    this.sidebarEl.innerHTML = '';

    // Goal / Tips Card
    const goalCard = document.createElement('section');
    goalCard.className = 'tw-card';
    goalCard.innerHTML = `<div class="tw-card-title">${
      this.progression.mode === 'alchemist' ? t(loc, 'panel_goal') : t(loc, 'panel_tips')
    }</div>`;
    this.goalBodyEl = document.createElement('div');
    goalCard.appendChild(this.goalBodyEl);

    // Inspector Card
    const inspCard = document.createElement('section');
    inspCard.className = 'tw-card';
    inspCard.innerHTML = `<div class="tw-card-title"><span>${t(loc, 'panel_inspector')}</span><span id="tw-fps">60 FPS</span></div>`;
    this.inspectorBodyEl = document.createElement('div');
    this.inspectorBodyEl.className = 'tw-kv-grid';
    inspCard.appendChild(this.inspectorBodyEl);

    // Sprites Card
    const spriteCard = document.createElement('section');
    spriteCard.className = 'tw-card';
    spriteCard.innerHTML = `<div class="tw-card-title">${t(loc, 'panel_sprites')}</div>`;
    this.spriteBodyEl = document.createElement('div');
    this.spriteBodyEl.className = 'tw-kv-grid';
    spriteCard.appendChild(this.spriteBodyEl);

    // Blueprint Card
    const bpCard = document.createElement('section');
    bpCard.className = 'tw-card';
    const bpHeader = document.createElement('div');
    bpHeader.className = 'tw-card-title';
    bpHeader.innerHTML = `<span>${t(loc, 'panel_blueprints')}</span>`;
    const bpActionRow = document.createElement('div');
    bpActionRow.style.display = 'flex';
    bpActionRow.style.gap = '5px';

    const btnCap = this.makeBtn(t(loc, 'btn_capture_bp'), this.isCapturingBp, () => {
      this.isCapturingBp = !this.isCapturingBp;
      this.blueprints.activeBlueprintId = null;
      this.bpDragStart = null;
      this.updateFloatingHint();
      this.refreshStaticUI();
    });
    btnCap.className = `tw-btn ${this.isCapturingBp ? 'active' : ''}`;
    bpActionRow.appendChild(btnCap);

    if (this.blueprints.activeBlueprintId) {
      const btnCancelBp = this.makeBtn(t(loc, 'btn_cancel_bp'), false, () => {
        this.blueprints.activeBlueprintId = null;
        this.refreshStaticUI();
      });
      btnCancelBp.className = 'tw-btn';
      bpActionRow.appendChild(btnCancelBp);
    }

    this.bpListEl = document.createElement('div');
    this.bpListEl.className = 'tw-bp-list';
    this.renderBlueprintChips();

    bpCard.append(bpHeader, bpActionRow, this.bpListEl);

    // Share / Load Card
    const shareCard = document.createElement('section');
    shareCard.className = 'tw-card';
    shareCard.innerHTML = `<div class="tw-card-title">${t(loc, 'panel_share')}</div>`;
    const shareBtns = document.createElement('div');
    shareBtns.style.display = 'flex';
    shareBtns.style.gap = '6px';

    const btnCopyUrl = this.makeBtn(t(loc, 'btn_copy_url'), false, () => {
      void this.copyShareUrl();
    });
    btnCopyUrl.className = 'tw-btn';

    const btnLoadCode = this.makeBtn(t(loc, 'btn_load_code'), false, () => {
      const input = window.prompt(t(this.locale, 'prompt_code'));
      if (input) {
        const ok = deserializeWorld(input, this.world, this.progression);
        if (ok) {
          this.sprites.clear();
          this.showToast(t(this.locale, 'toast_loaded'));
          this.refreshStaticUI();
        } else {
          this.showToast(t(this.locale, 'toast_load_err'));
        }
      }
    });
    btnLoadCode.className = 'tw-btn';
    shareBtns.append(btnCopyUrl, btnLoadCode);

    const dropHint = document.createElement('p');
    dropHint.className = 'tw-hint-small';
    dropHint.textContent = t(loc, 'png_drop_hint');
    shareCard.append(shareBtns, dropHint);

    this.sidebarEl.append(goalCard, inspCard, spriteCard, bpCard, shareCard);

    // 3. 下部ブラシ＆操作ドック構築
    this.dockEl.innerHTML = '';
    const brushRow = document.createElement('div');
    brushRow.className = 'tw-brushes';

    const available = this.progression.getAvailableBrushes();
    for (const mat of available) {
      const info = MATERIAL_LABELS[mat];
      const b = document.createElement('button');
      b.className = `tw-brush-btn ${
        !this.blueprints.activeBlueprintId && this.selectedMat === mat ? 'active' : ''
      }`;
      b.innerHTML = `<span>${info.icon}</span><span>${info[loc]}</span>`;
      b.title = loc === 'ja' ? info.hintJa : info.hintEn;
      b.addEventListener('click', () => {
        this.sound.unlock();
        this.selectedMat = mat;
        this.blueprints.activeBlueprintId = null;
        this.isCapturingBp = false;
        this.updateFloatingHint();
        this.refreshStaticUI();
      });
      brushRow.appendChild(b);
    }

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'tw-dock-controls';

    const leftCtrls = document.createElement('div');
    leftCtrls.style.display = 'flex';
    leftCtrls.style.alignItems = 'center';
    leftCtrls.style.gap = '8px';

    // ブラシサイズ切替
    const sizeSeg = document.createElement('div');
    sizeSeg.className = 'tw-seg';
    const sizes: { r: number; label: string }[] = [
      { r: 0, label: '• 1px' },
      { r: 2, label: '● S' },
      { r: 4, label: '⬤ M' },
      { r: 7, label: '⬤ L' },
    ];
    for (const s of sizes) {
      sizeSeg.appendChild(
        this.makeBtn(s.label, this.brushRadius === s.r, () => {
          this.brushRadius = s.r;
          this.refreshStaticUI();
        })
      );
    }

    // 速度切替
    const speedSeg = document.createElement('div');
    speedSeg.className = 'tw-seg';
    const speeds: { v: 0 | 1 | 2; label: string }[] = [
      { v: 0, label: '⏸️' },
      { v: 1, label: '▶️ 1x' },
      { v: 2, label: '⏩ 2x' },
    ];
    for (const sp of speeds) {
      speedSeg.appendChild(
        this.makeBtn(sp.label, this.simSpeed === sp.v, () => {
          this.simSpeed = sp.v;
          this.refreshStaticUI();
        })
      );
    }

    const activeInfo = MATERIAL_LABELS[this.selectedMat];
    const brushTip = document.createElement('span');
    brushTip.className = 'tw-brush-tooltip';
    brushTip.textContent = `${activeInfo.icon} ${activeInfo[loc]} — ${
      loc === 'ja' ? activeInfo.hintJa : activeInfo.hintEn
    }`;

    leftCtrls.append(sizeSeg, speedSeg, brushTip);

    const rightCtrls = document.createElement('div');
    rightCtrls.style.display = 'flex';
    rightCtrls.style.gap = '6px';

    if (this.zoom > 1.01 || this.panX !== 0 || this.panY !== 0) {
      const btnResetZoom = this.makeBtn(t(loc, 'btn_reset_view'), false, () => {
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        this.refreshStaticUI();
      });
      btnResetZoom.className = 'tw-btn';
      rightCtrls.appendChild(btnResetZoom);
    }

    const btnNew = this.makeBtn(t(loc, 'btn_new_world'), false, () => {
      this.startNewWorld(this.progression.mode);
    });
    btnNew.className = 'tw-btn';

    const btnSnap = this.makeBtn(t(loc, 'btn_snapshot'), false, () => {
      void this.downloadEmbeddedPngSnapshot();
    });
    btnSnap.className = 'tw-btn';

    rightCtrls.append(btnNew, btnSnap);
    ctrlRow.append(leftCtrls, rightCtrls);
    this.dockEl.append(brushRow, ctrlRow);

    this.updateHeaderBadges();
    this.updateSidebarDynamic();
  }

  private renderBlueprintChips(): void {
    this.bpListEl.innerHTML = '';
    for (const bp of this.blueprints.blueprints) {
      const chip = document.createElement('button');
      chip.className = `tw-bp-chip ${this.blueprints.activeBlueprintId === bp.id ? 'active' : ''}`;
      chip.textContent = `${bp.name} (${bp.width}×${bp.height})`;
      chip.addEventListener('click', () => {
        this.isCapturingBp = false;
        this.blueprints.activeBlueprintId =
          this.blueprints.activeBlueprintId === bp.id ? null : bp.id;
        this.updateFloatingHint();
        this.refreshStaticUI();
      });
      this.bpListEl.appendChild(chip);
    }
  }

  private updateFloatingHint(): void {
    if (this.isCapturingBp) {
      this.floatingHintEl.textContent = t(this.locale, 'bp_capturing_hint');
      this.floatingHintEl.style.display = 'block';
    } else {
      this.floatingHintEl.style.display = 'none';
    }
  }

  private makeBtn(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (active) b.classList.add('active');
    b.addEventListener('click', onClick);
    return b;
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (e) => {
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
      this.sound.unlock();
      this.canvas.setPointerCapture(e.pointerId);
      const pos = this.clientToGrid(e.clientX, e.clientY);
      this.hoverX = pos.x;
      this.hoverY = pos.y;
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;

      // 中クリック または Space押下中はパン移動
      if (e.button === 1 || (e.button === 0 && this.isSpaceDown)) {
        this.isPanning = true;
        return;
      }

      // ブループリント範囲キャプチャ開始
      if (this.isCapturingBp && e.button === 0) {
        this.bpDragStart = { x: pos.x, y: pos.y };
        return;
      }

      // ブループリントのスタンプ配置
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
        // 高速ドラッグ時に線が途切れないよう線形補間してブラシ適用
        this.paintLine(this.hoverX, this.hoverY, pos.x, pos.y);
      }

      this.hoverX = pos.x;
      this.hoverY = pos.y;
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (this.isCapturingBp && this.bpDragStart) {
        const end = this.clientToGrid(e.clientX, e.clientY);
        const defaultName = `Blueprint #${this.blueprints.blueprints.length + 1}`;
        const name = window.prompt(t(this.locale, 'prompt_bp_name'), defaultName);
        if (name) {
          const bp = this.blueprints.captureRegion(
            this.world,
            this.bpDragStart.x,
            this.bpDragStart.y,
            end.x,
            end.y,
            name
          );
          if (bp) {
            this.blueprints.activeBlueprintId = bp.id;
            this.showToast(t(this.locale, 'toast_bp_saved'));
          }
        }
        this.bpDragStart = null;
        this.isCapturingBp = false;
        this.updateFloatingHint();
        this.refreshStaticUI();
      }
      this.isDrawing = false;
      this.isPanning = false;
    });

    // ホイールによるズーム操作
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

    // PNG ファイルのドラッグ＆ドロップ復元
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
    // 1. シミュレーションステップ（一時停止=0, 通常=1, 倍速=2）
    for (let step = 0; step < this.simSpeed; step++) {
      stepSimulation(this.world);
      stepPowerAndMachines(this.world);
      if ((this.world.tick & 7) === 0) {
        stepProceduralDecor(this.world);
      }
      this.sprites.update(this.world);
      this.storyteller.update(this.world, this.sprites, this.progression);
    }

    // 2. プロシージャル環境オーディオの更新
    if (this.world.tick % 15 === 0) {
      const rainFactor = this.storyteller.currentWeather === 'monsoon' ? 1.0 : 0.08;
      this.sound.updateAmbient(rainFactor, this.world.isNight());
    }

    // 3. オフスクリーン描画＋スプライト描画＋グロー合成
    this.renderFrame();

    // 4. FPSとUIインスペクターの定期更新（10フレームごと）
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
      this.updateHeaderBadges();
      this.updateSidebarDynamic();
    }

    requestAnimationFrame(this.loop);
  };

  private renderFrame(): void {
    const showGuard =
      this.progression.mode === 'alchemist' &&
      this.isPointerInside &&
      this.selectedMat !== Mat.Air;

    // 1. 256x144 ピクセルのセル描画
    this.renderer.renderPixels(this.world, showGuard);

    // 2. 256x144 上にドット絵スプライトを描画
    this.sprites.render(this.renderer.offCtx, this.world);

    // 3. 15Hz または毎フレームのグローマップ更新
    if ((this.world.tick & 1) === 0) {
      const extraLights = this.sprites.getLightSources(this.world);
      this.lighting.updateGlowMap(this.world, extraLights);
    }

    // 4. メインキャンバスへズーム＆パン適用でシャープに転送
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

    // 5. 低解像度グローライトを滑らかなバイリニア補間＋Screen合成で重ねる
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

    // 6. カーソル・ブループリント選択オーバーレイ描画
    if (this.isPointerInside) {
      this.renderCursorOverlay(viewW, viewH);
    }
  }

  private renderCursorOverlay(viewW: number, viewH: number): void {
    const toScreenX = (gx: number) => ((gx - this.panX) / viewW) * DISPLAY_W;
    const toScreenY = (gy: number) => ((gy - this.panY) / viewH) * DISPLAY_H;
    const cellScreenW = DISPLAY_W / viewW;
    const cellScreenH = DISPLAY_H / viewH;

    this.ctx.save();

    // ブループリント矩形ドラッグ中
    if (this.isCapturingBp && this.bpDragStart) {
      const minX = Math.min(this.bpDragStart.x, this.hoverX);
      const maxX = Math.max(this.bpDragStart.x, this.hoverX);
      const minY = Math.min(this.bpDragStart.y, this.hoverY);
      const maxY = Math.max(this.bpDragStart.y, this.hoverY);
      this.ctx.strokeStyle = '#f6c458';
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([6, 4]);
      this.ctx.strokeRect(
        toScreenX(minX),
        toScreenY(minY),
        (maxX - minX + 1) * cellScreenW,
        (maxY - minY + 1) * cellScreenH
      );
      this.ctx.restore();
      return;
    }

    // ブループリントのゴーストスタンプ表示
    const activeBp = this.blueprints.getActive();
    if (activeBp) {
      const sx = this.hoverX - (activeBp.width >> 1);
      const sy = this.hoverY - (activeBp.height >> 1);
      this.ctx.strokeStyle = '#6cecb0';
      this.ctx.fillStyle = 'rgba(108, 236, 176, 0.14)';
      this.ctx.lineWidth = 2;
      const rx = toScreenX(sx);
      const ry = toScreenY(sy);
      const rw = activeBp.width * cellScreenW;
      const rh = activeBp.height * cellScreenH;
      this.ctx.fillRect(rx, ry, rw, rh);
      this.ctx.strokeRect(rx, ry, rw, rh);
      this.ctx.restore();
      return;
    }

    // 通常の円形ブラシカーソル
    const cx = toScreenX(this.hoverX + 0.5);
    const cy = toScreenY(this.hoverY + 0.5);
    const rPx = Math.max(cellScreenW * 0.5, (this.brushRadius + 0.5) * cellScreenW);
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private updateHeaderBadges(): void {
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

    this.timeBadgeEl.textContent = `⏱️ ${t(loc, 'day_prefix')} ${this.world.dayCount} (${t(loc, phaseKey)})`;

    const wKey = `weather_${this.storyteller.currentWeather}` as DictKey;
    this.weatherBadgeEl.textContent = t(loc, wKey);
    this.weatherBadgeEl.className = `tw-badge ${
      this.storyteller.currentWeather !== 'clear' ? 'weather-active' : ''
    }`;
  }

  private updateSidebarDynamic(): void {
    const loc = this.locale;

    // 1. 目標 / ヒント更新
    if (this.progression.mode === 'cozy') {
      this.goalBodyEl.innerHTML = `
        <p class="tw-goal-desc">• ${t(loc, 'cozy_tip_1')}</p>
        <p class="tw-goal-desc">• ${t(loc, 'cozy_tip_2')}</p>
        <p class="tw-goal-desc">• ${t(loc, 'cozy_tip_3')}</p>
        <p class="tw-goal-desc">• ${t(loc, 'cozy_tip_4')}</p>
      `;
    } else {
      const st = this.progression.getCurrentStageDef();
      if (!st) {
        this.goalBodyEl.innerHTML = `<p class="tw-goal-desc" style="color:var(--accent-mint)">${t(loc, 'all_stages_done')}</p>`;
      } else {
        const rows = st.requirements
          .map((req) => {
            const cur = this.progression.progress[req.kind];
            const pct = Math.min(100, Math.round((cur / req.target) * 100));
            const label = t(loc, `req_${req.kind}` as DictKey);
            return `
              <div class="tw-progress-row">
                <div class="tw-progress-label"><span>${label}</span><span>${cur} / ${req.target}</span></div>
                <div class="tw-progress-bar"><div class="tw-progress-fill" style="width:${pct}%"></div></div>
              </div>
            `;
          })
          .join('');
        const unlocks = st.unlockedBrushes
          .map((m) => `${MATERIAL_LABELS[m].icon}${MATERIAL_LABELS[m][loc]}`)
          .join(', ');
        this.goalBodyEl.innerHTML = `
          <div style="font-weight:600;font-size:12px;">${t(loc, st.titleKey as DictKey)}</div>
          <p class="tw-goal-desc">${t(loc, st.descKey as DictKey)}</p>
          ${rows}
          <p class="tw-hint-small" style="margin-top:4px;color:var(--accent-amber)">${t(loc, 'next_unlock')} ${unlocks}</p>
        `;
      }
    }

    // 2. タイル Inspector 更新
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

    this.inspectorBodyEl.innerHTML = `
      <span>${t(loc, 'insp_pos')}</span><span>(${this.hoverX}, ${this.hoverY})</span>
      <span>${t(loc, 'insp_tile')}</span><span>${matLabel.icon} ${matLabel[loc]}</span>
      <span>${t(loc, 'insp_bg')}</span><span>${t(loc, bgKey)}</span>
      <span>${t(loc, 'insp_temp')}</span><span>${this.world.temp[idx]} °C</span>
      <span>${t(loc, 'insp_charge')}</span><span>⚡${this.world.charge[idx]} / M:${this.world.meta[idx]}</span>
    `;

    // 3. スプライト数表示
    const counts = this.sprites.countByKind();
    this.spriteBodyEl.innerHTML = `
      <span>${t(loc, 'sprite_aqua')}</span><span>${counts.aqua_puff}</span>
      <span>${t(loc, 'sprite_root')}</span><span>${counts.root_roller}</span>
      <span>${t(loc, 'sprite_spark')}</span><span>${counts.spark_bit}</span>
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
    this.showToast(t(this.locale, 'toast_copied'));
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
    this.showToast(t(this.locale, 'toast_png_saved'));
  }

  private async importWorldFromPngFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const code = extractWorldFromPng(bytes);
    if (code && deserializeWorld(code, this.world, this.progression)) {
      this.sprites.clear();
      this.showToast(t(this.locale, 'toast_loaded'));
      this.refreshStaticUI();
    } else {
      this.showToast(t(this.locale, 'toast_load_err'));
    }
  }

  private showToast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('visible');
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('visible');
    }, 3400);
  }
}
