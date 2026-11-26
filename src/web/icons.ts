// Original, decorative Web glyphs. Visible adjacent text supplies their meaning.
// All colors and sizes inherit from the component's CSS.
const paths = {
  connect: '<rect x="2.5" y="6" width="15" height="12" rx="2"/><path d="m3 7 7 6 7-6M20 5h5m-5 3h5M22 3v2m2 3v3m-2 0h2a2 2 0 0 1 0 4h-3"/>',
  collaborate: '<path d="M4 4h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h6m-6 4h4m11-9 1.5 3.5L27 9l-3.5 1.5L22 14l-1.5-3.5L17 9l3.5-1.5Z"/>',
  control: '<path d="M14 2.5 24 6v7c0 6-5 10-10 13C9 23 4 19 4 13V6l10-3.5Z"/><path d="m9 14 3.5 3.5L19 11"/>',
  arrow: '<path d="M7 21 21 7M9 7h12v12"/>',
  mail: '<rect x="3" y="6" width="22" height="16" rx="2"/><path d="m4 7 10 8L24 7"/>',
  key: '<circle cx="9" cy="10" r="6"/><path d="m13 14 11 11m-5-5 3-3m-6 0 3-3"/>',
} as const;

export function webIcon(name: keyof typeof paths): string {
  return `<svg class="web-icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
