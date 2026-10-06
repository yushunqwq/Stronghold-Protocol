// 公告 (Announcements): simple modal listing server announcements.
//
// Static list for now — edit ANNOUNCEMENTS to publish. Entries are { date, title, body }.
// Global & imperative like guide.js: `openAnnouncements()`; <AnnounceHost/> is mounted once
// by main.js; <AnnounceButton/> is the standard trigger.

import { html, Modal, Button } from './components.js';
import { createStore, useStore } from '../store.js';

/** @type {Array<{ date: string, title: string, body: string }>} body is HTML. */
export const ANNOUNCEMENTS = [
  {
    date: '2026-10-07',
    title: '服务器公告',
    body: `<h4>服务说明</h4>
<p>本站服务器带宽很小，无法保证晚高峰加载速度<br>
本站纯公益，可能不定时停服更新，对此造成的不便请见谅<br>
闪断对局不中断的功能有考虑开发</p>
<h4>近期更新内容</h4>
<p>同步上游 0.1.4 版本<br>
增加匹配功能<br>
增加倍速切换功能<br>
在线人数显示<br>
公告功能</p>
<h4>反馈</h4>
<p>B 站：<a href="https://space.bilibili.com/545653981" target="_blank" rel="noopener">Yushun_Zero</a></p>
<h4>赞助</h4>
<p>不强制要求赞助，您可以向 Alipay 账户：yushun_zero@163.com 赞助<br>
承诺所有赞助均用来续费和升级服务器</p>
<h4>鸣谢</h4>
<p>感谢 @Ausevay 开发本项目 <a href="https://space.bilibili.com/429961520" target="_blank" rel="noopener">https://space.bilibili.com/429961520</a></p>`,
  },
];

const announceStore = createStore({ open: false });

const SEEN_KEY = 'stronghold.announce.seen';

/** Hash of the current announcements content (date+title+body). */
function contentHash() {
  const s = JSON.stringify(ANNOUNCEMENTS.map((a) => [a.date, a.title, a.body]));
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

/** Open the announcements modal. */
export function openAnnouncements() {
  announceStore.set({ open: true });
}

/** Close the announcements modal (marks current content as seen). */
export function closeAnnouncements() {
  try { localStorage.setItem(SEEN_KEY, contentHash()); } catch { /* ignore */ }
  announceStore.set({ open: false });
}

/**
 * Auto-open on page load when the announcements are new/changed since last seen
 * (or never seen). Call once at boot (main.js).
 */
export function maybeAutoOpenAnnouncements() {
  if (!ANNOUNCEMENTS.length) return;
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* ignore */ }
  if (seen !== contentHash()) openAnnouncements();
}

function AnnounceModal() {
  const open = useStore((s) => s.open, Object.is, announceStore);
  return html`<${Modal} open=${open} onClose=${closeAnnouncements} title="服务器公告" micro="ANNOUNCEMENTS" width="7rem"
    actions=${html`<${Button} variant="primary" onClick=${closeAnnouncements}>关闭<//>`}>
    <div class="announce-list">
      ${ANNOUNCEMENTS.length === 0 ? html`<p class="t-lo">暂无公告</p>` : ANNOUNCEMENTS.map((a, i) => html`
        <article class="announce-item" key=${i}>
          <div class="announce-item__body" dangerouslySetInnerHTML=${{ __html: a.body }}></div>
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
