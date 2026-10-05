// preload.js — 资源预载 (resource preloading): collect what the next screens need, download it
// ahead of time with progress, and hold the battle's Spine models until the fight starts.
//
// Two tiers:
//   * lobby tier (silent, once the player has entered): title / lobby / room art, profession icons,
//     the UI SFX and the lobby BGM — so the shell never pops art in late.
//   * match tier (floating progress card, when the match reaches INFO_CHECK): the boss + the
//     faction-pool enemy icons and Spine models, this match's bond / band icons, the player's own
//     loadout operators (art + Spine), the combat BGM and battle SFX.
//
// Spine models preloaded for a match are HELD (refcounted, see assets.js RefLru) until the first
// battle starts or the match ends: the idle memory budget would otherwise evict them during the
// briefing / draft minutes before the battle ever references them. Images and audio stay in their
// own caches, which are never evicted.
//
// Pure at import time (no DOM, no PIXI): the collectors take the manifest / match data and are
// unit tested in Node. The runner takes the stores (`assets`, `audio`) as arguments.

import { spineEntry } from './assets.js';
import {
  uiUrl, enemyIconUrl, factionIconUrl, bondIconUrl, bandIconUrl,
  chessAvatarUrl, chessPortraitUrl, skillIconUrl,
} from './ui/assetUrls.js';

const str = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

/** Push a URL once (dedup). */
function pushUrl(out, seen, u) {
  const s = str(u);
  if (s && !seen.has(s)) { seen.add(s); out.push(s); }
}

/** Push a manifest Spine entry once (dedup by .skel). */
function pushSpine(out, seen, e) {
  if (e && str(e.skel) && !seen.has(e.skel)) { seen.add(e.skel); out.push(e); }
}

/** `{ intro?, loop }` → its URLs. */
function bgmUrls(out, seen, b) {
  if (!obj(b)) return;
  pushUrl(out, seen, b.intro);
  pushUrl(out, seen, b.loop);
}

/** SFX URLs of one manifest audio group (`ui` / `battle`). */
function sfxUrls(m, group) {
  const g = obj(obj(obj(m)?.audio)?.sfx)?.[group];
  return g ? Object.values(g).filter(str) : [];
}

// ---- collectors (pure) ---------------------------------------------------------------------------------

/**
 * Lobby-tier plan: art the title / lobby / room screens need, plus the UI sounds.
 * @param {any} m the /data/assets.json manifest (or null)
 * @returns {{ images: string[], spines: [], audios: string[] }}
 */
export function collectLobbyPlan(m) {
  const images = [], seen = new Set();
  const audios = [], aseen = new Set();
  // title screen backdrop candidates (screens/title.js BACKDROP_KEYS / RIDGE_KEYS)
  for (const k of ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02', 'titleRidges', 'entry/bg_mountains_tiled']) {
    pushUrl(images, seen, uiUrl(m, k));
  }
  // room screen mode icons + the profession icons used across lobby / room / draft
  for (const k of ['modeIcon/mode_training_icon', 'modeIcon/mode_normal_icon', 'modeIcon/mode_hard_icon',
    'modeIcon/mode_abyss_icon', 'modeIcon/mode_funny_icon']) pushUrl(images, seen, uiUrl(m, k));
  for (const kind of ['icon', 'large']) {
    const g = obj(obj(m)?.prof)?.[kind];
    if (g) for (const u of Object.values(g)) pushUrl(images, seen, u);
  }
  // battlefield renderer sprites (render/app.js) — tiny, always needed once a match starts
  for (const k of ['battle/sprite_shadow', 'battle/sprite_direction_arrow', 'battle/sprite_direction_ring',
    'battle/sprite_box_shadow']) pushUrl(images, seen, uiUrl(m, k));
  for (const u of sfxUrls(m, 'ui')) pushUrl(audios, aseen, u);
  const bgm = obj(obj(obj(m)?.audio)?.bgm);
  bgmUrls(audios, aseen, bgm && bgm.lobby);
  return { images, spines: [], audios };
}

/**
 * Enemy ids of the match's 特训敌人 faction pools (factions.json `types[t].pool`).
 * @param {any} pub m.public
 * @param {any} gd game-data lookups (ui/gameComponents.js makeLookups)
 */
export function matchFactionEnemyIds(pub, gd) {
  const out = [];
  const seen = new Set();
  const types = obj(gd && gd.factions)?.types;
  for (const t of arr(pub && pub.factions)) {
    const id = str(t) || str(t && t.type);
    const pool = id && types ? arr(types[id] && types[id].pool) : [];
    for (const k of pool) { const s = str(k); if (s && !seen.has(s)) { seen.add(s); out.push(s); } }
  }
  return out;
}

/**
 * Match-tier plan, built when the match reaches INFO_CHECK (the briefing): everything the
 * briefing, the band draft and the first battles will ask for.
 * @param {any} m the /data/assets.json manifest (or null)
 * @param {any} pub m.public
 * @param {any} gd game-data lookups (ui/gameComponents.js makeLookups)
 * @param {string[]} [loadoutIds] the player's own loadout base chess ids (room.state seats[].loadout keys)
 * @returns {{ images: string[], spines: object[], audios: string[] }}
 */
export function collectMatchPlan(m, pub, gd, loadoutIds) {
  const images = [], seen = new Set();
  const spines = [], sseen = new Set();
  const audios = [], aseen = new Set();

  // enemy roster: the boss (icon + model) and the faction-pool enemies (icon + model)
  const boss = pub && pub.bossId && gd ? gd.boss(pub.bossId) : null;
  const bossKey = str(boss && boss.enemyKey);
  const enemyIds = matchFactionEnemyIds(pub, gd);
  for (const k of enemyIds) pushUrl(images, seen, enemyIconUrl(m, k));
  if (bossKey) pushUrl(images, seen, enemyIconUrl(m, bossKey));

  // briefing blocks: faction icons, this match's bonds, every band (the draft shows them all),
  // 本局禁用干员 avatars
  const types = obj(gd && gd.factions)?.types;
  for (const t of arr(pub && pub.factions)) {
    const id = str(t) || str(t && t.type);
    if (id && types && types[id]) pushUrl(images, seen, factionIconUrl(m, types[id].icon));
  }
  for (const b of arr(pub && pub.bonds)) pushUrl(images, seen, bondIconUrl(m, str(b) || str(b && b.id)));
  if (gd) for (const band of gd.list('bands')) pushUrl(images, seen, bandIconUrl(m, str(band && band.id)));
  for (const key of ['bannedChess', 'banned', 'disabledChess']) {
    for (const id of arr(pub && pub[key])) {
      const rec = gd ? gd.chess(str(id)) : null;
      pushUrl(images, seen, rec ? chessAvatarUrl(m, rec) : null);
    }
  }

  // the player's own loadout operators (art + Spine): they are on the field from round 1
  if (gd) {
    for (const id of arr(loadoutIds)) {
      const rec = gd.chess(str(id));
      if (!rec) continue;
      pushUrl(images, seen, chessAvatarUrl(m, rec));
      pushUrl(images, seen, chessPortraitUrl(m, rec));
      pushUrl(images, seen, skillIconUrl(m, rec));
      pushSpine(spines, sseen, spineEntry(m, str(rec.charId)));
    }
  }

  // Spine models: faction-pool enemies first, the boss LAST (most-recently-used, evicted last
  // under memory pressure); capped — the roster of a match is a few dozen models at most.
  for (const k of enemyIds) pushSpine(spines, sseen, spineEntry(m, k));
  if (bossKey) pushSpine(spines, sseen, spineEntry(m, bossKey));
  const capped = spines.slice(0, MAX_MATCH_SPINES);

  // audio: combat BGM (+ the boss track when this match has one), prep BGM, battle + UI SFX
  const audio = obj(obj(m)?.audio);
  const bgm = obj(audio && audio.bgm);
  if (bgm) { bgmUrls(audios, aseen, bgm.combat); bgmUrls(audios, aseen, bgm.prep); }
  const bossBgm = obj(audio && audio.bossBgm);
  if (bossBgm && pub && pub.bossId) bgmUrls(audios, aseen, bossBgm[pub.bossId]);
  for (const u of sfxUrls(m, 'battle')) pushUrl(audios, aseen, u);
  for (const u of sfxUrls(m, 'ui')) pushUrl(audios, aseen, u);
  return { images, spines: capped, audios };
}

/** How many Spine models a match preload holds at most. */
export const MAX_MATCH_SPINES = 24;

/** Progress units of a plan (images + spines + one audio batch). */
export function planTotal(plan) {
  const p = obj(plan) || {};
  return arr(p.images).length + arr(p.spines).length + (arr(p.audios).length ? 1 : 0);
}

// ---- runner ------------------------------------------------------------------------------------------------

/** The currently running preload (for the overlay's 跳过 button). */
let activeRun = null;

/** Abort the currently running preload, if any. */
export function cancelPreload() {
  if (activeRun) activeRun.abort();
}

const chunk = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

/**
 * Run a plan. Never rejects: every failure is counted, never thrown. `onProgress(done, total, label)`
 * fires after each unit; `signal` (AbortSignal) stops between chunks. With `holdSpines`, the preloaded
 * Spine models stay referenced until the returned `release()` runs (the match tier: the battle views
 * take their own refs later); without it they are released at once and only warm the LRU.
 *
 * @param {{ images?: string[], spines?: object[], audios?: string[] }} plan
 * @param {{ assets: any, audio?: any, onProgress?: (done:number,total:number,label:string)=>void,
 *           signal?: AbortSignal|null, holdSpines?: boolean, label?: string }} opts
 * @returns {Promise<{ ok: number, failed: number, total: number, cancelled: boolean, release: () => void }>}
 */
export async function runPreload(plan, opts = {}) {
  const { assets, audio = null, onProgress = null, holdSpines = false, label = '' } = opts;
  const images = arr(plan && plan.images);
  const spines = arr(plan && plan.spines);
  const audios = arr(plan && plan.audios);
  const total = images.length + spines.length + (audios.length ? 1 : 0);
  const outer = opts.signal || null;
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  const run = { abort: () => ctrl.abort() };
  activeRun = run;
  const held = []; // spine entries acquired and held
  const progress = (done) => { try { onProgress && onProgress(done, total, label); } catch { /* ignore */ } };
  let done = 0, ok = 0, failed = 0;
  const release = () => {
    for (const e of held.splice(0)) { try { assets && assets.spine.release(e); } catch { /* ignore */ } }
  };
  try {
    const aborted = () => ctrl.signal.aborted;
    // images, in chunks (the asset store never rejects: failures resolve to null)
    if (assets && typeof assets.preload === 'function') {
      for (const c of chunk(images, 16)) {
        if (aborted()) break;
        try {
          const r = await assets.preload(c, () => { done++; progress(done); });
          ok += r.ok; failed += r.failed;
        } catch { done += c.length; failed += c.length; progress(done); }
      }
    } else { done += images.length; failed += images.length; progress(done); }
    // spine models, a few at a time (the RefLru caps concurrency itself)
    if (assets && assets.spine) {
      for (const c of chunk(spines, 4)) {
        if (aborted()) break;
        const rs = await Promise.all(c.map((e) => assets.spine.acquire(e).then(
          () => ({ ok: true, entry: e }),
          () => ({ ok: false, entry: e }),
        )));
        for (const r of rs) {
          done++; progress(done);
          if (r.ok) {
            ok++;
            if (holdSpines) held.push(r.entry);
            else { try { assets.spine.release(r.entry); } catch { /* ignore */ } }
          } else failed++;
        }
      }
    } else { done += spines.length; failed += spines.length; progress(done); }
    // audio: one batch (the AudioManager buffers + decodes in the background; a no-op before unlock)
    if (audios.length) {
      if (!aborted() && audio && typeof audio.preload === 'function') {
        try { audio.preload(audios); ok++; } catch { failed++; }
      } else failed++;
      done++; progress(done);
    }
  } finally {
    if (outer) outer.removeEventListener('abort', onOuter);
    if (activeRun === run) activeRun = null;
    if (ctrl.signal.aborted) release(); // a cancelled run never keeps models held
  }
  return { ok, failed, total, cancelled: ctrl.signal.aborted, release };
}
