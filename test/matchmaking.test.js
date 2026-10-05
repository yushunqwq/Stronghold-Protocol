// test/matchmaking.test.js — alliance match (同盟匹配, server/lobby.js + server/matchmaking.js):
// the queue (queueing by difficulty, team formation, leaving, guards). When 4 real players of the
// same difficulty are queued, the server seats them in a fresh co-op room and starts its match
// immediately — no room lobby, no AI teammates. Boots real servers in-process with the matchmaker
// timer disabled (tickMs: 0) and drives tick() by hand.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch as Match } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR } from '../shared/constants.js';

const MM = { tickMs: 0, teamSize: 4 };

let srv, url;
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: { info() {}, warn() {}, error() {}, debug() {} }, MatchClass: Match, matchmaking: MM });
  url = srv.url.replace('http://', 'ws://') + '/ws';
});
after(async () => { await srv.close(); });

const clients = new Set();
async function player(name) {
  const c = await TestClient.connect(url);
  clients.add(c);
  const w = await c.hello(name, undefined);
  c.id = w.playerId;
  return c;
}
async function closeAll() {
  await Promise.all([...clients].map((c) => c.terminate().catch(() => {})));
  clients.clear();
}

async function mmJoin(c, difficulty = 'NORMAL') {
  const r = await c.request({ t: 'matchmaking.join', difficulty });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  return c.waitFor('matchmaking.state', (m) => m.inQueue === true);
}

describe('matchmaking queue', () => {
  test('four players queue → the match starts immediately (no lobby, no bots)', async () => {
    const ps = await Promise.all(['m1', 'm2', 'm3', 'm4'].map(player));
    try {
      for (const c of ps) await mmJoin(c);
      srv.lobby.matchmaker.tick();
      const founds = await Promise.all(ps.map((c) => c.waitFor('matchmaking.found', undefined, 3000)));
      const codes = new Set(founds.map((f) => f.code));
      assert.equal(codes.size, 1, 'one room for the whole team');
      const code = founds[0].code;
      // the match started by itself: 4 humans, no bots, everyone in the match
      for (const c of ps) {
        const st = await c.waitFor('room.state', (s) => s.code === code && s.inMatch === true, 3000);
        assert.equal(st.seats.filter((s) => s && !s.isBot).length, 4, 'four humans');
        assert.equal(st.seats.filter((s) => s && s.isBot).length, 0, 'no auto-added bots');
      }
      // the queue is empty now
      assert.equal(srv.lobby.matchmaker.queued(ps[0].id), false);
    } finally { await closeAll(); }
  });

  test('fewer than four players keep waiting (no timeout, no short team)', async () => {
    const ps = await Promise.all(['w1', 'w2', 'w3'].map(player));
    try {
      for (const c of ps) await mmJoin(c);
      srv.lobby.matchmaker.tick();
      for (const c of ps) await c.expectNone('matchmaking.found', () => true, 300);
      for (const c of ps) assert.equal(srv.lobby.matchmaker.queued(c.id), true, 'still queued');
      // the waiting count is broadcast
      const st = await ps[0].waitFor('matchmaking.state', (m) => m.inQueue === true && m.waiting === 3, 2000);
      assert.equal(st.waiting, 3);
    } finally { await closeAll(); }
  });

  test('leaving the queue stops matchmaking for that player', async () => {
    const [a, b] = await Promise.all([player('q1'), player('q2')]);
    try {
      await mmJoin(a);
      await mmJoin(b);
      const r = await a.request({ t: 'matchmaking.leave' });
      assert.equal(r.t, 'ok');
      await a.waitFor('matchmaking.state', (m) => m.inQueue === false, 2000);
      srv.lobby.matchmaker.tick();
      await b.expectNone('matchmaking.found', () => true, 200);
      assert.equal(srv.lobby.matchmaker.queued(a.id), false);
      assert.equal(srv.lobby.matchmaker.queued(b.id), true);
      // leaving twice is fine (idempotent)
      const r2 = await a.request({ t: 'matchmaking.leave' });
      assert.equal(r2.t, 'ok');
    } finally { await closeAll(); }
  });

  test('queueing while your room runs a match fails with ROOM_STARTED', async () => {
    const c = await player('busy');
    try {
      const r = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      assert.equal(r.t, 'ok');
      await c.waitFor('room.state', (s) => s.hostId === c.id);
      const rs = await c.request({ t: 'room.start' });
      assert.equal(rs.t, 'ok', JSON.stringify(rs));
      await c.waitFor('room.state', (s) => s.inMatch === true, 3000);
      const bad = await c.request({ t: 'matchmaking.join', difficulty: 'NORMAL' });
      assert.equal(bad.t, 'error');
      assert.equal(bad.code, ERR.ROOM_STARTED);
    } finally { await closeAll(); }
  });

  test('queueing leaves a LOBBY room (like room.create / room.join)', async () => {
    const c = await player('roamer');
    try {
      const r = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      assert.equal(r.t, 'ok');
      const st = await c.waitFor('room.state', (s) => s.hostId === c.id);
      const code = st.code;
      await mmJoin(c);
      assert.equal(srv.lobby.getRoom(code), null, 'the old room was disposed');
    } finally { await closeAll(); }
  });

  test('creating or joining a room cancels matchmaking', async () => {
    const c = await player('fickle');
    try {
      await mmJoin(c);
      assert.equal(srv.lobby.matchmaker.queued(c.id), true);
      const r = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      assert.equal(r.t, 'ok');
      await c.waitFor('room.state', (s) => s.hostId === c.id);
      assert.equal(srv.lobby.matchmaker.queued(c.id), false, 'room.create drops the queue entry');
      // and re-queueing works after leaving the room
      await c.request({ t: 'room.leave' });
      await mmJoin(c);
      assert.equal(srv.lobby.matchmaker.queued(c.id), true);
    } finally { await closeAll(); }
  });

  test('disconnect drops the queue entry', async () => {
    const c = await player('quitter');
    try {
      await mmJoin(c);
      assert.equal(srv.lobby.matchmaker.queued(c.id), true);
      await c.terminate();
      clients.delete(c);
      await new Promise((r) => setTimeout(r, 100)); // let the server observe the close
      assert.equal(srv.lobby.matchmaker.queued(c.id), false);
    } finally { await closeAll(); }
  });

  test('different difficulties queue separately', async () => {
    const ps = await Promise.all(['d1', 'd2', 'd3', 'd4', 'd5'].map(player));
    try {
      await mmJoin(ps[0], 'NORMAL');
      await mmJoin(ps[1], 'NORMAL');
      await mmJoin(ps[2], 'HARD');
      await mmJoin(ps[3], 'HARD');
      await mmJoin(ps[4], 'HARD');
      srv.lobby.matchmaker.tick();
      // nobody has 4 of the same difficulty: no team forms
      for (const c of ps) await c.expectNone('matchmaking.found', () => true, 300);
      for (const c of ps) assert.equal(srv.lobby.matchmaker.queued(c.id), true);
    } finally { await closeAll(); }
  });

  test('startNow: tired of waiting → AI fills the seats and the match starts', async () => {
    const [a, b] = await Promise.all([player('impatient'), player('patient2')]);
    try {
      await mmJoin(a, 'NORMAL');
      await mmJoin(b, 'NORMAL');
      srv.lobby.matchmaker.tick();
      // only 2 queued: no team forms yet
      await a.expectNone('matchmaking.found', () => true, 200);
      // a skips the wait: AI teammates fill the empty seats, the match starts at once
      const r = await a.request({ t: 'matchmaking.startNow' });
      assert.equal(r.t, 'ok', JSON.stringify(r));
      const found = await a.waitFor('matchmaking.found', undefined, 3000);
      const st = await a.waitFor('room.state', (s) => s.code === found.code && s.inMatch === true, 3000);
      assert.equal(st.seats.filter((s) => s && !s.isBot).length, 1, 'only the requester');
      assert.equal(st.seats.filter((s) => s && s.isBot).length, 3, 'AI fills the rest');
      assert.equal(srv.lobby.matchmaker.queued(a.id), false, 'no longer queued');
      // the other queued player is unaffected
      assert.equal(srv.lobby.matchmaker.queued(b.id), true, 'still waiting');
      await b.expectNone('matchmaking.found', () => true, 200);
    } finally { await closeAll(); }
  });

  test('startNow without queueing fails', async () => {
    const c = await player('loner');
    try {
      const bad = await c.request({ t: 'matchmaking.startNow' });
      assert.equal(bad.t, 'error');
    } finally { await closeAll(); }
  });
});

describe('matchmaking protocol', () => {
  test('validateC2S accepts the new messages, rejects bad fields', () => {
    assert.equal(validateC2S({ t: 'matchmaking.join', difficulty: 'NORMAL' }), null);
    assert.equal(validateC2S({ t: 'matchmaking.leave' }), null);
    assert.equal(validateC2S({ t: 'matchmaking.startNow' }), null);
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }), null);
    // unknown fields are ignored, not rejected
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', quickMatch: true }), null);
    assert.ok(validateC2S({ t: 'matchmaking.join', difficulty: 'NOPE' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.join' }).startsWith('bad field'));
    // matchmaking.seek was removed
    assert.ok(validateC2S({ t: 'matchmaking.seek', on: true }).startsWith('unknown type'));
  });
});
