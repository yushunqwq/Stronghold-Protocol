// PreloadOverlay — 资源预载的悬浮进度卡片 (public/js/preload.js).
//
// A small non-modal card at the bottom of the screen while a preload runs: progress bar +
// percentage + the current stage label. It never blocks the screen behind it (the briefing's
// 准备就绪 button stays clickable), and the 跳过 button aborts the run — preloading is an
// optimization, never a gate. Driven by `store.ui.preload`
// (`{ open, done, total, label, skippable } | null`); hidden while no run is active.

import { html } from './components.js';
import { useStore } from '../store.js';
import { cancelPreload } from '../preload.js';

export function PreloadOverlay() {
  const pre = useStore((s) => s.ui.preload);
  if (!pre || !pre.open) return null;
  const total = Math.max(0, pre.total | 0);
  const done = Math.min(Math.max(0, pre.done | 0), total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`<div class="preload-card" role="status" aria-live="polite">
    <div class="preload-card__head">
      <span class="preload-card__label">${pre.label || '正在预载资源'}</span>
      <b class="preload-card__pct num">${pct}%</b>
    </div>
    <div class="preload-card__bar" aria-hidden="true"><i style=${`width:${pct}%`}></i></div>
    ${pre.skippable ? html`<button type="button" class="preload-card__skip" onClick=${() => cancelPreload()}>跳过</button>` : null}
  </div>`;
}
