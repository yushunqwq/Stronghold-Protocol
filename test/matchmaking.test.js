// test/matchmaking.test.js — quick-match queue (server/matchmaking.js): queueing by difficulty,
// team formation (full team, timeout with bots), leaving, and the guards. Boots real servers
// in-process with the matchmaker timer disabled (tickMs: 0) and drives tick() by hand.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch as Match } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR } from '../shared/constants.js';

const MM = { tickMs: 0, queueTimeoutMs: 120, teamSize: 4 };

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
  test('four players queue → they land in a room lobby (no auto-start, no auto bots)', async () => {
    const ps = await Promise.all(['m1', 'm2', 'm3', 'm4'].map(player));
    try {
      for (const c of ps) await mmJoin(c);
      srv.lobby.matchmaker.tick();
      const founds = await Promise.all(ps.map((c) => c.waitFor('matchmaking.found', undefined, 3000)));
      const codes = new Set(founds.map((f) => f.code));
      assert.equal(codes.size, 1, 'one room for the whole team');
      const code = founds[0].code;
      // everyone was seated in the room lobby: no match yet, no bots, nobody forced ready
      for (const c of ps) {
        const st = await c.waitFor('room.state', (s) => s.code === code && s.seats.filter((x) => x && !x.isBot).length === 4, 3000);
        assert.equal(st.inMatch, false, 'the match does not start by itself');
        assert.equal(st.seats.filter((s) => s && s.isBot).length, 0, 'no auto-added bots');
        assert.ok(st.seats.every((s) => !s || s.isBot || s.ready === false), 'nobody is forced ready');
      }
      // the first queued player hosts: everyone readies up and the host starts like any other room
      const host = ps[0];
      const lobby = await host.waitFor('room.state', (s) => s.code === code, 2000);
      assert.equal(lobby.hostId, host.id, 'the first queued player hosts');
      for (const c of ps) {
        const r = await c.request({ t: 'room.ready', ready: true });
        assert.equal(r.t, 'ok');
      }
      const rs = await host.request({ t: 'room.start' });
      assert.equal(rs.t, 'ok', JSON.stringify(rs));
      const started = await host.waitFor('room.state', (s) => s.code === code && s.inMatch === true, 3000);
      assert.equal(started.seats.filter((s) => s && !s.isBot).length, 4);
    } finally { await closeAll(); }
  });

  test('a lone player is seated after the queue timeout and adds bots by hand', async () => {
    const c = await player('solo-q');
    try {
      await mmJoin(c, 'FUNNY');
      await new Promise((r) => setTimeout(r, MM.queueTimeoutMs + 50));
      srv.lobby.matchmaker.tick();
      const found = await c.waitFor('matchmaking.found', undefined, 3000);
      const st = await c.waitFor('room.state', (s) => s.code === found.code && s.inMatch === false, 3000);
      const humans = st.seats.filter((s) => s && !s.isBot);
      const bots = st.seats.filter((s) => s && s.isBot);
      assert.equal(humans.length, 1);
      assert.equal(bots.length, 0, 'bots are added by the host, not the matchmaker');
      assert.equal(st.hostId, c.id);
      // the host fills the room with AI teammates before starting
      const r = await c.request({ t: 'room.addBot' });
      assert.equal(r.t, 'ok');
      const withBot = await c.waitFor('room.state', (s) => s.seats.filter((x) => x && x.isBot).length === 1, 2000);
      assert.equal(withBot.seats.filter((s) => s && !s.isBot).length, 1);
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
});

describe('matchmaking protocol', () => {
  test('validateC2S accepts the new messages, rejects bad fields', () => {
    assert.equal(validateC2S({ t: 'matchmaking.join', difficulty: 'NORMAL' }), null);
    assert.equal(validateC2S({ t: 'matchmaking.leave' }), null);
    assert.ok(validateC2S({ t: 'matchmaking.join', difficulty: 'NOPE' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.join' }).startsWith('bad field'));
  });
});
