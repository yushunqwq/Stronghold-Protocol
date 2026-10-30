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

  test('startNow with bots: vote passes → the group starts together, AI fills the seats', async () => {
    const [a, b] = await Promise.all([player('impatient'), player('patient2')]);
    try {
      await mmJoin(a, 'NORMAL');
      await mmJoin(b, 'NORMAL');
      srv.lobby.matchmaker.tick();
      await a.expectNone('matchmaking.found', () => true, 200);
      // a opens a vote (auto-agrees: 1/2)
      const r = await a.request({ t: 'matchmaking.startNow', withBots: true });
      assert.equal(r.t, 'ok', JSON.stringify(r));
      const vs = await a.waitFor('matchmaking.voteState', (m) => m.agree === 1 && m.total === 2, 2000);
      assert.equal(vs.withBots, true);
      assert.equal(vs.needed, 2);
      // b agrees → 2/2 majority → the match starts
      const vb = await b.request({ t: 'matchmaking.vote', agree: true });
      assert.equal(vb.t, 'ok');
      const founds = await Promise.all([a, b].map((c) => c.waitFor('matchmaking.found', undefined, 3000)));
      const codes = new Set(founds.map((f) => f.code));
      assert.equal(codes.size, 1, 'same room for the whole group');
      const code = founds[0].code;
      for (const c of [a, b]) {
        const st = await c.waitFor('room.state', (s) => s.code === code && s.inMatch === true, 3000);
        assert.equal(st.seats.filter((s) => s && !s.isBot).length, 2, 'both humans');
        assert.equal(st.seats.filter((s) => s && s.isBot).length, 2, 'AI fills the rest');
      }
      assert.equal(srv.lobby.matchmaker.queued(a.id), false, 'no longer queued');
      assert.equal(srv.lobby.matchmaker.queued(b.id), false, 'no longer queued');
    } finally { await closeAll(); }
  });

  test('startNow without bots: 3 players, 2 agree → the group plays short-handed', async () => {
    const [a, b, c] = await Promise.all([player('s1'), player('s2'), player('s3')]);
    try {
      await mmJoin(a, 'HARD');
      await mmJoin(b, 'HARD');
      await mmJoin(c, 'HARD');
      srv.lobby.matchmaker.tick();
      await a.expectNone('matchmaking.found', () => true, 200);
      // b opens a vote (1/3, needs 2)
      const r = await b.request({ t: 'matchmaking.startNow', withBots: false });
      assert.equal(r.t, 'ok', JSON.stringify(r));
      await b.waitFor('matchmaking.voteState', (m) => m.agree === 1 && m.total === 3, 2000);
      // a agrees → 2/3 majority → pass (c never votes)
      assert.equal((await a.request({ t: 'matchmaking.vote', agree: true })).t, 'ok');
      const founds = await Promise.all([a, b, c].map((p) => p.waitFor('matchmaking.found', undefined, 3000)));
      const codes = new Set(founds.map((f) => f.code));
      assert.equal(codes.size, 1, 'same room for the whole group');
      const code = founds[0].code;
      for (const p of [a, b, c]) {
        const st = await p.waitFor('room.state', (s) => s.code === code && s.inMatch === true, 3000);
        assert.equal(st.seats.filter((s) => s && !s.isBot).length, 3, 'three humans');
        assert.equal(st.seats.filter((s) => s && s.isBot).length, 0, 'no AI');
      }
    } finally { await closeAll(); }
  });

  test('startNow vote rejected: disagree blocks the start', async () => {
    const [a, b] = await Promise.all([player('no1'), player('no2')]);
    try {
      await mmJoin(a, 'NORMAL');
      await mmJoin(b, 'NORMAL');
      srv.lobby.matchmaker.tick();
      assert.equal((await a.request({ t: 'matchmaking.startNow', withBots: true })).t, 'ok');
      await a.waitFor('matchmaking.voteState', (m) => m.agree === 1, 2000);
      // b disagrees → cannot reach majority → vote fails
      assert.equal((await b.request({ t: 'matchmaking.vote', agree: false })).t, 'ok');
      const end = await a.waitFor('matchmaking.voteEnd', undefined, 2000);
      assert.equal(end.passed, false);
      await b.waitFor('matchmaking.voteEnd', (m) => m.passed === false, 2000);
      // nobody started; both still queued
      await a.expectNone('matchmaking.found', () => true, 200);
      assert.equal(srv.lobby.matchmaker.queued(a.id), true);
      assert.equal(srv.lobby.matchmaker.queued(b.id), true);
    } finally { await closeAll(); }
  });

  test('startNow vote cancelled by initiator', async () => {
    const [a, b] = await Promise.all([player('canc1'), player('canc2')]);
    try {
      await mmJoin(a, 'NORMAL');
      await mmJoin(b, 'NORMAL');
      srv.lobby.matchmaker.tick();
      assert.equal((await a.request({ t: 'matchmaking.startNow', withBots: true })).t, 'ok');
      await a.waitFor('matchmaking.voteState', (m) => m.agree === 1, 2000);
      // non-initiator cannot cancel
      const bad = await b.request({ t: 'matchmaking.voteCancel' });
      assert.equal(bad.t, 'error');
      // initiator cancels
      assert.equal((await a.request({ t: 'matchmaking.voteCancel' })).t, 'ok');
      const end = await a.waitFor('matchmaking.voteEnd', undefined, 2000);
      assert.equal(end.passed, false);
      assert.equal(end.cancelled, true);
      await b.waitFor('matchmaking.voteEnd', (m) => m.cancelled === true, 2000);
      // both still queued, no match started
      await a.expectNone('matchmaking.found', () => true, 200);
      assert.equal(srv.lobby.matchmaker.queued(a.id), true);
      assert.equal(srv.lobby.matchmaker.queued(b.id), true);
    } finally { await closeAll(); }
  });

  test('startNow alone: no vote, starts at once with AI fill', async () => {
    const c = await player('solo-starter');
    try {
      await mmJoin(c, 'FUNNY');
      srv.lobby.matchmaker.tick();
      const r = await c.request({ t: 'matchmaking.startNow', withBots: true });
      assert.equal(r.t, 'ok', JSON.stringify(r));
      await c.expectNone('matchmaking.voteState', () => true, 200, 'no vote when alone');
      const found = await c.waitFor('matchmaking.found', undefined, 3000);
      const st = await c.waitFor('room.state', (s) => s.code === found.code && s.inMatch === true, 3000);
      assert.equal(st.seats.filter((s) => s && !s.isBot).length, 1);
      assert.equal(st.seats.filter((s) => s && s.isBot).length, 3);
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
    assert.equal(validateC2S({ t: 'matchmaking.startNow', withBots: true }), null);
    assert.equal(validateC2S({ t: 'matchmaking.startNow', withBots: false }), null);
    assert.equal(validateC2S({ t: 'matchmaking.vote', agree: true }), null);
    assert.equal(validateC2S({ t: 'matchmaking.vote', agree: false }), null);
    assert.equal(validateC2S({ t: 'matchmaking.voteCancel' }), null);
    assert.ok(validateC2S({ t: 'matchmaking.startNow' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.startNow', withBots: 'yes' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.vote' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.vote', agree: 'yes' }).startsWith('bad field'));
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }), null);
    // unknown fields are ignored, not rejected
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', quickMatch: true }), null);
    assert.ok(validateC2S({ t: 'matchmaking.join', difficulty: 'NOPE' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.join' }).startsWith('bad field'));
    // matchmaking.seek was removed
    assert.ok(validateC2S({ t: 'matchmaking.seek', on: true }).startsWith('unknown type'));
  });
});
