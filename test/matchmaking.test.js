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

const MM = { tickMs: 0, queueTimeoutMs: 120, seekTimeoutMs: 400, teamSize: 4 };

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

  test('a seeking room takes queued individuals of the same difficulty', async () => {
    const host = await player('seeker');
    const filler = await player('filler');
    try {
      // the host gets a quick-match room alone via the queue timeout
      await mmJoin(host, 'NORMAL');
      await new Promise((r) => setTimeout(r, MM.queueTimeoutMs + 50));
      srv.lobby.matchmaker.tick();
      const found = await host.waitFor('matchmaking.found', undefined, 3000);
      const code = found.code;
      const st0 = await host.waitFor('room.state', (s) => s.code === code && s.quickMatch === true, 3000);
      assert.equal(st0.seeking, false);
      assert.equal(st0.seats.filter((s) => s && !s.isBot).length, 1);
      // the host opens the empty seats to the queue (after adding one AI teammate by hand)
      const ab = await host.request({ t: 'room.addBot' });
      assert.equal(ab.t, 'ok');
      const sk = await host.request({ t: 'matchmaking.seek', on: true });
      assert.equal(sk.t, 'ok');
      await host.waitFor('room.state', (s) => s.code === code && s.seeking === true, 2000);
      // an individual queues and lands in the seeking room instead of a new one
      await mmJoin(filler, 'NORMAL');
      srv.lobby.matchmaker.tick();
      const ff = await filler.waitFor('matchmaking.found', undefined, 3000);
      assert.equal(ff.code, code, 'the filler joins the seeking room');
      const st1 = await host.waitFor('room.state',
        (s) => s.code === code && s.seats.filter((x) => x && !x.isBot).length === 2, 3000);
      assert.equal(st1.seeking, true, 'still seeking with one empty seat left');
      assert.equal(srv.lobby.matchmaker.queued(filler.id), false);
    } finally { await closeAll(); }
  });

  test('seeking stops when the room fills; the host can cancel; guests cannot seek', async () => {
    const host = await player('seeker2');
    try {
      await mmJoin(host, 'HARD');
      await new Promise((r) => setTimeout(r, MM.queueTimeoutMs + 50));
      srv.lobby.matchmaker.tick();
      const found = await host.waitFor('matchmaking.found', undefined, 3000);
      const code = found.code;
      await host.waitFor('room.state', (s) => s.code === code && s.quickMatch === true, 3000);
      // no empty seats: seeking is refused
      for (let i = 0; i < 3; i++) assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
      const bad = await host.request({ t: 'matchmaking.seek', on: true });
      assert.equal(bad.t, 'error');
      assert.equal(bad.code, ERR.ALREADY);
      // free one seat, seek, then cancel
      assert.equal((await host.request({ t: 'room.removeBot', seat: 1 })).t, 'ok');
      assert.equal((await host.request({ t: 'matchmaking.seek', on: true })).t, 'ok');
      await host.waitFor('room.state', (s) => s.code === code && s.seeking === true, 2000);
      assert.equal((await host.request({ t: 'matchmaking.seek', on: false })).t, 'ok');
      await host.waitFor('room.state', (s) => s.code === code && s.seeking === false, 2000);
      // a guest cannot seek
      const guest = await player('guest2');
      try {
        assert.equal((await guest.request({ t: 'room.join', code })).t, 'ok');
        await guest.waitFor('room.state', (s) => s.code === code && s.seats.some((x) => x && x.playerId === guest.id), 2000);
        const nb = await guest.request({ t: 'matchmaking.seek', on: true });
        assert.equal(nb.t, 'error');
        assert.equal(nb.code, ERR.NOT_HOST);
      } finally { clients.delete(guest); await guest.terminate().catch(() => {}); }
    } finally { await closeAll(); }
  });

  test('seeking times out and the host starts by hand', async () => {
    const host = await player('patient');
    try {
      await mmJoin(host, 'ABYSS');
      await new Promise((r) => setTimeout(r, MM.queueTimeoutMs + 50));
      srv.lobby.matchmaker.tick();
      const found = await host.waitFor('matchmaking.found', undefined, 3000);
      const code = found.code;
      await host.waitFor('room.state', (s) => s.code === code, 3000);
      assert.equal((await host.request({ t: 'matchmaking.seek', on: true })).t, 'ok');
      await host.waitFor('room.state', (s) => s.code === code && s.seeking === true, 2000);
      // nobody queues: after seekTimeoutMs the tick stops seeking (no auto-start)
      await new Promise((r) => setTimeout(r, MM.seekTimeoutMs + 100));
      srv.lobby.matchmaker.tick();
      const st = await host.waitFor('room.state', (s) => s.code === code && s.seeking === false, 2000);
      assert.equal(st.inMatch, false, 'no auto-start: the host starts by hand');
    } finally { await closeAll(); }
  });
});

describe('matchmaking protocol', () => {
  test('validateC2S accepts the new messages, rejects bad fields', () => {
    assert.equal(validateC2S({ t: 'matchmaking.join', difficulty: 'NORMAL' }), null);
    assert.equal(validateC2S({ t: 'matchmaking.leave' }), null);
    assert.equal(validateC2S({ t: 'matchmaking.seek', on: true }), null);
    assert.ok(validateC2S({ t: 'matchmaking.join', difficulty: 'NOPE' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.join' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.seek', on: 'yes' }).startsWith('bad field'));
    assert.ok(validateC2S({ t: 'matchmaking.seek' }).startsWith('bad field'));
  });
});
