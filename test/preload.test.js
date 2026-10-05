// Tests for the resource preloading feature (public/js/preload.js): the pure collectors
// (lobby / match plans from a manifest + match data) and the runner (progress, hold/release of
// Spine models, cancellation, never rejects).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectLobbyPlan, collectMatchPlan, matchFactionEnemyIds, planTotal, runPreload, cancelPreload,
  MAX_MATCH_SPINES,
} from '../public/js/preload.js';

const spine = (name) => ({ skel: `/assets/spine/${name}.skel`, atlas: `/assets/spine/${name}.atlas`, anims: { Idle: {} } });

// a minimal manifest shaped like /data/assets.json
const manifest = () => ({
  chars: {
    char_002_amiya: {
      avatar: '/assets/avatars/char_002_amiya.png', portrait: '/assets/portraits/char_002_amiya.png',
      spine: { front: spine('amiya') },
    },
  },
  enemies: {
    enemy_1007_slime: { icon: '/assets/enemies/slime.png', spine: spine('slime') },
    enemy_1041_lazerd: { icon: '/assets/enemies/lazerd.png', spine: spine('lazerd') },
    enemy_9013_acstmk: { icon: '/assets/enemies/boss.png', spine: spine('boss') },
  },
  bonds: { bond_a: '/assets/bonds/a.png' },
  bands: { band_x: '/assets/bands/x.png' },
  skills: { sk_1: '/assets/skills/1.png' },
  ui: {
    'titleBackdrop': '/assets/ui/title.png',
    'entry/bkg_01': '/assets/ui/bkg01.png',
    'modeIcon/mode_normal_icon': '/assets/ui/mode_normal.png',
    'battle/sprite_shadow': '/assets/ui/shadow.png',
    'enemyTypeIcon/fly_icon': '/assets/ui/fly.png',
    'skillIcon/empty': '/assets/ui/empty_skill.png',
  },
  prof: {
    icon: { sniper: '/assets/prof/sniper.png', caster: '/assets/prof/caster.png' },
    large: { sniper: '/assets/prof/sniper_l.png' },
  },
  audio: {
    bgm: { lobby: { loop: '/assets/audio/bgm/lobby.mp3' }, combat: { intro: '/assets/audio/bgm/c_i.mp3', loop: '/assets/audio/bgm/c.mp3' }, prep: { loop: '/assets/audio/bgm/p.mp3' } },
    bossBgm: { boss_1: { loop: '/assets/audio/bgm/boss1.mp3' } },
    sfx: { ui: { click: '/assets/audio/sfx/click.mp3' }, battle: { deploy: '/assets/audio/sfx/deploy.mp3' } },
  },
});

// minimal game-data lookups (ui/gameComponents.js makeLookups)
const lookups = (m) => ({
  m,
  boss: (id) => (id === 'boss_1' ? { bossId: 'boss_1', enemyKey: 'enemy_9013_acstmk' } : null),
  chess: (id) => (id === 'chess_amiya' ? { chessId: 'chess_amiya', charId: 'char_002_amiya', skill: { iconId: 'sk_1' } } : null),
  factions: { types: { FLY: { icon: 'fly_icon', pool: ['enemy_1041_lazerd'] } } },
  list: (name) => (name === 'bands' ? [{ id: 'band_x' }] : []),
});

const pub = () => ({ phase: 'INFO_CHECK', bossId: 'boss_1', factions: ['FLY'], bonds: ['bond_a'] });

// ---- collectors ----------------------------------------------------------------------------------------

describe('collectLobbyPlan', () => {
  test('collects title art, mode + profession icons, battle sprites, ui sfx and the lobby bgm', () => {
    const p = collectLobbyPlan(manifest());
    assert.deepEqual(p.spines, []);
    for (const u of ['/assets/ui/title.png', '/assets/ui/mode_normal.png', '/assets/prof/sniper.png',
      '/assets/prof/sniper_l.png', '/assets/ui/shadow.png']) {
      assert.ok(p.images.includes(u), u);
    }
    assert.ok(p.audios.includes('/assets/audio/sfx/click.mp3'));
    assert.ok(p.audios.includes('/assets/audio/bgm/lobby.mp3'));
    // deduped
    assert.equal(p.images.length, new Set(p.images).size);
  });

  test('tolerates a missing manifest', () => {
    const p = collectLobbyPlan(null);
    assert.deepEqual(p, { images: [], spines: [], audios: [] });
  });
});

describe('matchFactionEnemyIds', () => {
  test('maps faction types to their pools, deduped', () => {
    const ids = matchFactionEnemyIds({ factions: ['FLY', 'FLY'] }, lookups());
    assert.deepEqual(ids, ['enemy_1041_lazerd']);
  });

  test('unknown types and missing data give nothing', () => {
    assert.deepEqual(matchFactionEnemyIds({ factions: ['NOPE'] }, lookups()), []);
    assert.deepEqual(matchFactionEnemyIds({}, lookups()), []);
    assert.deepEqual(matchFactionEnemyIds(null, null), []);
  });
});

describe('collectMatchPlan', () => {
  test('boss + faction enemies: icons as images, spines with the boss last', () => {
    const m = manifest();
    const p = collectMatchPlan(m, pub(), lookups(m), []);
    assert.ok(p.images.includes('/assets/enemies/boss.png'));
    assert.ok(p.images.includes('/assets/enemies/lazerd.png'));
    assert.ok(p.images.includes('/assets/ui/fly.png'));   // faction icon
    assert.ok(p.images.includes('/assets/bonds/a.png'));  // bond icon
    assert.ok(p.images.includes('/assets/bands/x.png'));  // band icon
    assert.ok(p.audios.includes('/assets/audio/bgm/c.mp3'));      // combat bgm
    assert.ok(p.audios.includes('/assets/audio/bgm/boss1.mp3'));   // boss bgm
    assert.ok(p.audios.includes('/assets/audio/sfx/deploy.mp3')); // battle sfx
    const skels = p.spines.map((e) => e.skel);
    assert.ok(skels.includes('/assets/spine/lazerd.skel'));
    assert.equal(skels[skels.length - 1], '/assets/spine/boss.skel'); // boss is freshest in the LRU
  });

  test('own loadout operators add art + spine', () => {
    const m = manifest();
    const p = collectMatchPlan(m, pub(), lookups(m), ['chess_amiya']);
    assert.ok(p.images.includes('/assets/avatars/char_002_amiya.png'));
    assert.ok(p.images.includes('/assets/portraits/char_002_amiya.png'));
    assert.ok(p.images.includes('/assets/skills/1.png'));
    assert.ok(p.spines.some((e) => e.skel === '/assets/spine/amiya.skel'));
  });

  test('spine list is capped', () => {
    const m = manifest();
    m.enemies = {};
    for (let i = 0; i < MAX_MATCH_SPINES + 10; i++) m.enemies[`e_${i}`] = { icon: `/i/${i}.png`, spine: spine(`s${i}`) };
    const gd = lookups(m);
    gd.factions = { types: { FLY: { icon: 'fly_icon', pool: Object.keys(m.enemies) } } };
    const p = collectMatchPlan(m, { factions: ['FLY'] }, gd, []);
    assert.ok(p.spines.length <= MAX_MATCH_SPINES);
  });

  test('tolerates missing data everywhere', () => {
    const p = collectMatchPlan(null, null, null, null);
    assert.deepEqual(p.images, []);
    assert.deepEqual(p.spines, []);
    assert.deepEqual(p.audios, []);
  });
});

describe('planTotal', () => {
  test('images + spines + one audio batch', () => {
    assert.equal(planTotal({ images: ['a', 'b'], spines: [{}, {}], audios: ['x'] }), 5);
    assert.equal(planTotal({ images: ['a'], spines: [], audios: [] }), 1);
    assert.equal(planTotal(null), 0);
  });
});

// ---- runner --------------------------------------------------------------------------------------------

function fakeStores() {
  const assets = {
    preloaded: [],
    spine: {
      acquired: [], released: [],
      acquire: async (e) => { assets.spine.acquired.push(e.skel); return { skel: e.skel }; },
      release: (e) => { assets.spine.released.push(e.skel); },
    },
    preload: async (urls, onProgress) => {
      assets.preloaded.push(...urls);
      for (const u of urls) { try { onProgress && onProgress(); } catch { /* ignore */ } }
      return { ok: urls.length, failed: 0, total: urls.length };
    },
  };
  const audio = { preloaded: null, preload(urls) { this.preloaded = urls; } };
  return { assets, audio };
}

describe('runPreload', () => {
  test('progress counts every unit; audio is one batch; resolves a summary', async () => {
    const { assets, audio } = fakeStores();
    const seen = [];
    const res = await runPreload(
      { images: ['i1', 'i2'], spines: [spine('a'), spine('b')], audios: ['s1'] },
      { assets, audio, onProgress: (d, t) => seen.push([d, t]) },
    );
    assert.equal(res.total, 5);
    assert.equal(res.ok, 5);
    assert.equal(res.failed, 0);
    assert.equal(res.cancelled, false);
    assert.deepEqual(seen[seen.length - 1], [5, 5]);
    assert.deepEqual(audio.preloaded, ['s1']);
    // not held: every spine released right away
    assert.deepEqual(assets.spine.acquired.sort(), ['/assets/spine/a.skel', '/assets/spine/b.skel'].sort());
    assert.deepEqual(assets.spine.released.sort(), assets.spine.acquired.slice().sort());
    assert.equal(typeof res.release, 'function');
  });

  test('holdSpines keeps the models until release()', async () => {
    const { assets, audio } = fakeStores();
    const res = await runPreload({ images: [], spines: [spine('a')], audios: [] }, { assets, audio, holdSpines: true });
    assert.deepEqual(assets.spine.released, []);
    res.release();
    assert.deepEqual(assets.spine.released, ['/assets/spine/a.skel']);
  });

  test('failures are counted, never thrown', async () => {
    const { assets, audio } = fakeStores();
    assets.preload = async () => { throw new Error('nope'); };
    assets.spine.acquire = async () => { throw new Error('nope'); };
    audio.preload = () => { throw new Error('nope'); };
    const res = await runPreload(
      { images: ['i1'], spines: [spine('a')], audios: ['s1'] },
      { assets, audio },
    );
    assert.equal(res.failed, 3);
    assert.equal(res.ok, 0);
  });

  test('an abort stops the run and releases held models', async () => {
    const { assets, audio } = fakeStores();
    const ctrl = new AbortController();
    let calls = 0;
    assets.spine.acquire = async (e) => {
      calls++;
      if (calls === 2) ctrl.abort(); // abort between batches
      assets.spine.acquired.push(e.skel);
      return {};
    };
    const spines = [spine('a'), spine('b'), spine('c'), spine('d'), spine('e')];
    const res = await runPreload({ images: [], spines, audios: ['s1'] }, { assets, audio, holdSpines: true, signal: ctrl.signal });
    assert.equal(res.cancelled, true);
    assert.ok(calls < spines.length, 'stopped early');
    assert.equal(audio.preloaded, null); // the audio batch never ran
    assert.deepEqual(assets.spine.released.sort(), assets.spine.acquired.slice().sort());
  });

  test('cancelPreload aborts the active run', async () => {
    const { assets, audio } = fakeStores();
    let secondBatch = false;
    const orig = assets.preload;
    assets.preload = async (urls, onProgress) => {
      const r = await orig(urls, onProgress);
      if (!secondBatch) { secondBatch = true; cancelPreload(); }
      return r;
    };
    const images = Array.from({ length: 40 }, (_, i) => `i${i}`);
    const res = await runPreload({ images, spines: [], audios: [] }, { assets, audio });
    assert.equal(res.cancelled, true);
    assert.ok(assets.preloaded.length < images.length);
  });

  test('empty plan resolves immediately', async () => {
    const { assets, audio } = fakeStores();
    const res = await runPreload({ images: [], spines: [], audios: [] }, { assets, audio });
    assert.deepEqual([res.ok, res.failed, res.total, res.cancelled], [0, 0, 0, false]);
  });
});
