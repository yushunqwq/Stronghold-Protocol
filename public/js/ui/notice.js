// 顶部通知横幅 (Notice banner): a dismissible banner at the top of the page,
// e.g. maintenance announcements. Edit NOTICES to publish; empty array hides it.
//
// Entries are { tag, text }. Only the first entry is shown. Dismissing stores
// the content hash so it won't show again until the content changes.

import { html } from './components.js';
import { createStore, useStore } from '../store.js';

/** @type {Array<{ tag: string, text: string }>} */
export const NOTICES = [
  { tag: '维护通知', text: '19:00 更新 0.2.0，届时可能对局断开' },
];

const noticeStore = createStore({ visible: false });

const SEEN_KEY = 'stronghold.notice.seen';

/** Hash of the current notice content. */
function contentHash() {
  const s = JSON.stringify(NOTICES.map((n) => [n.tag, n.text]));
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

/** Dismiss the banner (marks current content as seen). */
export function dismissNotice() {
  try { localStorage.setItem(SEEN_KEY, contentHash()); } catch { /* ignore */ }
  noticeStore.set({ visible: false });
}

/**
 * Show the banner on page load when there is a notice the user hasn't dismissed.
 * Call once at boot (main.js).
 */
export function maybeShowNotice() {
  if (!NOTICES.length) return;
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* ignore */ }
  if (seen !== contentHash()) noticeStore.set({ visible: true });
}

function NoticeBanner() {
  const visible = useStore((s) => s.visible, Object.is, noticeStore);
  if (!visible || !NOTICES.length) return null;
  const n = NOTICES[0];
  return html`<div class="notice-banner" role="alert">
    <div class="notice-banner__stripe" aria-hidden="true"></div>
    <span class="notice-banner__tag">${n.tag}</span>
    <span class="notice-banner__icon">⏳</span>
    <span class="notice-banner__text">${n.text}</span>
    <button type="button" class="notice-banner__close" aria-label="关闭" onClick=${dismissNotice}>✕</button>
  </div>`;
}

/** Mount once (main.js) to host the banner. */
export function NoticeHost() {
  return html`<${NoticeBanner} />`;
}
