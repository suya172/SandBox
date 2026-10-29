/**
 * 単色・統一ストローク幅 (1.5px) の機能的SVGアイコン定義
 * AGENTS.md UI Design System 準拠: 必要な操作箇所にのみ最小限で使用し、絵文字は一切使用しない
 */

export type IconName =
  | 'pause'
  | 'play'
  | 'fastForward'
  | 'volumeOn'
  | 'volumeOff'
  | 'capture'
  | 'link'
  | 'upload'
  | 'download'
  | 'refresh';

const ICON_PATHS: Record<IconName, string> = {
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  play: '<path d="M5 3.5l7 4.5-7 4.5V3.5z"/>',
  fastForward: '<path d="M2.5 4l5 4-5 4V4zM8.5 4l5 4-5 4V4z"/>',
  volumeOn:
    '<path d="M3 6.5h2.5L9 3.5v9l-3.5-3H3v-3z"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5"/>',
  volumeOff:
    '<path d="M3 6.5h2.5L9 3.5v9l-3.5-3H3v-3z"/><path d="M11 6l3 4M14 6l-3 4"/>',
  capture:
    '<path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/>',
  link:
    '<path d="M6.5 9.5l3-3"/><path d="M5.5 7L4 8.5a2.12 2.12 0 0 0 3 3L8.5 10"/><path d="M10.5 9L12 7.5a2.12 2.12 0 0 0-3-3L7.5 6"/>',
  upload: '<path d="M8 10.5V3M5 6l3-3 3 3M3 13h10"/>',
  download: '<path d="M8 3v7.5M5 7.5l3 3 3-3M3 13h10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.4-3.5M13 3v2.5h-2.5"/>',
};

export function renderIconSvg(name: IconName): string {
  return `<svg class="tw-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

