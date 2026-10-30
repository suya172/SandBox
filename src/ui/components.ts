import { IconName, renderIconSvg } from './icons';

/**
 * 共通UIコンポーネント生成ヘルパー
 * すべてのボタン・セグメント・モーダルで統一されたデザインシステム規則を適用する
 */

export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  title?: string;
  active?: boolean;
  variant?: 'default' | 'segment' | 'ghost';
  onClick: () => void;
}

export function createUIButton(opts: ButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';

  if (opts.variant === 'segment') {
    btn.className = 'tw-seg-btn';
  } else if (opts.variant === 'ghost') {
    btn.className = 'tw-btn tw-btn-ghost';
  } else {
    btn.className = 'tw-btn';
  }

  if (opts.active) {
    btn.classList.add('is-selected');
    btn.setAttribute('aria-pressed', 'true');
  } else {
    btn.setAttribute('aria-pressed', 'false');
  }

  if (opts.title) {
    btn.title = opts.title;
    if (!opts.label) {
      btn.setAttribute('aria-label', opts.title);
    }
  }

  if (opts.icon && opts.label) {
    btn.innerHTML = `${renderIconSvg(opts.icon)}<span>${escapeHtml(opts.label)}</span>`;
  } else if (opts.icon) {
    btn.innerHTML = renderIconSvg(opts.icon);
  } else if (opts.label) {
    btn.textContent = opts.label;
  }

  btn.addEventListener('click', opts.onClick);
  return btn;
}

export interface InputModalOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: (value: string) => void;
  onCancel?: () => void;
}

/**
 * デザインシステム準拠のインライン入力モーダル（コード読込・ブループリント保存画面で共有）
 */
export class InputModalController {
  readonly backdropEl: HTMLElement;
  private titleEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private confirmBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private currentConfirm: ((value: string) => void) | null = null;
  private currentCancel: (() => void) | null = null;

  constructor() {
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'tw-modal-backdrop';
    this.backdropEl.hidden = true;

    const dialog = document.createElement('div');
    dialog.className = 'tw-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'tw-modal-title';

    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.className = 'tw-input';

    const actions = document.createElement('div');
    actions.className = 'tw-modal-actions';

    this.cancelBtn = document.createElement('button');
    this.cancelBtn.type = 'button';
    this.cancelBtn.className = 'tw-btn';
    this.cancelBtn.addEventListener('click', () => this.close(false));

    this.confirmBtn = document.createElement('button');
    this.confirmBtn.type = 'button';
    this.confirmBtn.className = 'tw-btn tw-btn-primary';
    this.confirmBtn.addEventListener('click', () => this.close(true));

    actions.append(this.cancelBtn, this.confirmBtn);
    dialog.append(this.titleEl, this.inputEl, actions);
    this.backdropEl.appendChild(dialog);

    this.backdropEl.addEventListener('click', (e) => {
      if (e.target === this.backdropEl) this.close(false);
    });

    this.inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close(false);
      }
    });
  }

  open(opts: InputModalOptions): void {
    this.titleEl.textContent = opts.title;
    this.inputEl.placeholder = opts.placeholder ?? '';
    this.inputEl.value = opts.defaultValue ?? '';
    this.confirmBtn.textContent = opts.confirmLabel;
    this.cancelBtn.textContent = opts.cancelLabel;
    this.currentConfirm = opts.onConfirm;
    this.currentCancel = opts.onCancel ?? null;
    this.backdropEl.hidden = false;
    requestAnimationFrame(() => {
      this.inputEl.focus();
      this.inputEl.select();
    });
  }

  isOpen(): boolean {
    return !this.backdropEl.hidden;
  }

  close(confirmed: boolean): void {
    if (this.backdropEl.hidden) return;
    this.backdropEl.hidden = true;
    const val = this.inputEl.value.trim();
    const onConfirm = this.currentConfirm;
    const onCancel = this.currentCancel;
    this.currentConfirm = null;
    this.currentCancel = null;
    if (confirmed && val && onConfirm) {
      onConfirm(val);
    } else if (!confirmed && onCancel) {
      onCancel();
    }
  }
}

export interface CollapseModalOptions {
  title: string;
  description: string;
  retryLabel: string;
  newWorldLabel: string;
  onRetryDawn: () => void;
  onNewWorld: () => void;
}

/**
 * テラリウム・コア耐久値 0（全滅）時に表示するソリッドリトライモーダル
 * 直前の日の出スナップショットへの巻き戻し、または新規ワールド生成を選択できる
 */
export class CollapseModalController {
  readonly backdropEl: HTMLElement;
  private titleEl: HTMLElement;
  private descEl: HTMLElement;
  private retryBtn: HTMLButtonElement;
  private newWorldBtn: HTMLButtonElement;
  private currentRetry: (() => void) | null = null;
  private currentNewWorld: (() => void) | null = null;

  constructor() {
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'tw-modal-backdrop';
    this.backdropEl.hidden = true;

    const dialog = document.createElement('div');
    dialog.className = 'tw-modal is-danger';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'tw-modal-title';

    this.descEl = document.createElement('p');
    this.descEl.className = 'tw-modal-desc';

    const actions = document.createElement('div');
    actions.className = 'tw-modal-actions';

    this.newWorldBtn = document.createElement('button');
    this.newWorldBtn.type = 'button';
    this.newWorldBtn.className = 'tw-btn';
    this.newWorldBtn.addEventListener('click', () => {
      const fn = this.currentNewWorld;
      this.close();
      fn?.();
    });

    this.retryBtn = document.createElement('button');
    this.retryBtn.type = 'button';
    this.retryBtn.className = 'tw-btn tw-btn-primary';
    this.retryBtn.addEventListener('click', () => {
      const fn = this.currentRetry;
      this.close();
      fn?.();
    });

    actions.append(this.newWorldBtn, this.retryBtn);
    dialog.append(this.titleEl, this.descEl, actions);
    this.backdropEl.appendChild(dialog);
  }

  open(opts: CollapseModalOptions): void {
    this.titleEl.textContent = opts.title;
    this.descEl.textContent = opts.description;
    this.retryBtn.textContent = opts.retryLabel;
    this.newWorldBtn.textContent = opts.newWorldLabel;
    this.currentRetry = opts.onRetryDawn;
    this.currentNewWorld = opts.onNewWorld;
    this.backdropEl.hidden = false;
    requestAnimationFrame(() => {
      this.retryBtn.focus();
    });
  }

  isOpen(): boolean {
    return !this.backdropEl.hidden;
  }

  close(): void {
    this.backdropEl.hidden = true;
    this.currentRetry = null;
    this.currentNewWorld = null;
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

