// 公告 (Announcements): simple modal listing server announcements.
//
// Static list for now — edit ANNOUNCEMENTS to publish. Entries are { date, title, body }.
// Global & imperative like guide.js: `openAnnouncements()`; <AnnounceHost/> is mounted once
// by main.js; <AnnounceButton/> is the standard trigger.

import { html, Modal, Button } from './components.js';
import { createStore, useStore } from '../store.js';

/** @type {Array<{ date: string, title: string, body: string }>} */
export const ANNOUNCEMENTS = [
  {
    date: '2026-10-07',
    title: 'v0.1.4 版本更新',
    body: '已同步上游 v0.1.4 版本内容，保留同盟匹配、多数投票、在线人数、战斗倍速等自定义功能。',
  },
  {
    date: '2026-10-06',
    title: '同盟匹配投票功能上线',
    body: '匹配人数不足时可发起投票，多数同意即可直接开始或 AI 补位开始。发起人可随时取消投票。',
  },
];

const announceStore = createStore({ open: false });

/** Open the announcements modal. */
export function openAnnouncements() {
  announceStore.set({ open: true });
}

/** Close the announcements modal. */
export function closeAnnouncements() {
  announceStore.set({ open: false });
}

function AnnounceModal() {
  const open = useStore(announceStore, (s) => s.open);
  return html`<${Modal} open=${open} onClose=${closeAnnouncements} title="公告" micro="ANNOUNCEMENTS" width="7rem">
    <div class="announce-list">
      ${ANNOUNCEMENTS.length === 0 ? html`<p class="t-lo">暂无公告</p>` : ANNOUNCEMENTS.map((a, i) => html`
        <article class="announce-item" key=${i}>
          <div class="announce-item__head">
            <b>${a.title}</b>
            <span class="t-lo">${a.date}</span>
          </div>
          <p>${a.body}</p>
        </article>
      `)}
    </div>
  <//>`;
}

/** Mount once (main.js) to host the modal. */
export function AnnounceHost() {
  return html`<${AnnounceModal} />`;
}

/** Standard trigger button (title screen). */
export function AnnounceButton({ class: cls, size = 'sm', variant = 'ghost', label = '公告' }) {
  return html`<${Button} variant=${variant} size=${size} icon="info" class=${cls}
    onClick=${openAnnouncements} title="公告" aria-label="公告">${label}<//>`;
}
