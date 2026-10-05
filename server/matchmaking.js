// server/matchmaking.js — alliance match queue (同盟匹配).
//
// Players opt in with `matchmaking.join { difficulty }`; the matchmaker groups them by difficulty and,
// on every tick, seats each complete team of 4 in a fresh co-op room and starts its match immediately —
// no room lobby, no AI teammates. The room is an ordinary room from then on; its match runs like any other.
//
// Rules:
//   * one queue entry per player; joining with a new difficulty moves the entry (the wait restarts);
//     joining while in a LOBBY room leaves it (like room.create / room.join); joining while your room
//     runs a match fails with ROOM_STARTED.
//   * only real players are matched (never bots); a team forms only when 4 are queued — no timeout,
//     no short teams. Cancel anytime with `matchmaking.leave`; `matchmaking.startNow { withBots }`
//     skips the wait: the queued group enters one room and the match starts at once (AI fills the
//     empty seats when withBots, otherwise the humans play short-handed).
//   * disconnect / expiry / a manual room.create/join/spectate drops the entry (the tick also sweeps
//     entries whose session is gone, disconnected, or seated meanwhile).
//   * `matchmaking.state { inQueue, waiting, difficulty }` is pushed to the entry's difficulty group on
//     every join/leave/form; `matchmaking.found { code }` goes to each formed player (room.state and the
//     match frames follow on their own).
//   * a failed form never throws into the tick: its humans go back to the queue with their original wait.

import { ERR } from '../shared/constants.js';
import { sendSession } from './net.js';

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });

/** Tunables. */
export const MATCHMAKING_DEFAULTS = Object.freeze({
  teamSize: 4,          // humans per formed team (real players only — never bots, never short teams)
  tickMs: 2000,         // 0 = no timer (tests drive tick() by hand)
  maxQueue: 200,
});

export class Matchmaker {
  /**
   * @param {{ lobby: import('./lobby.js').Lobby, now?: () => number,
   *   options?: Partial<typeof MATCHMAKING_DEFAULTS>, timers?: { set: Function, clear: Function } }} opts
   */
  constructor({ lobby, now = Date.now, options = {}, timers = null }) {
    this.lobby = lobby;
    this.now = now;
    this.opts = { ...MATCHMAKING_DEFAULTS, ...options };
    /** @type {Map<string, { playerId: string, difficulty: string, joinedAt: number }>} */
    this.queue = new Map();
    this._timers = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
    this._timer = null;
    this._disposed = false;
    if (this.opts.tickMs > 0) this._arm();
  }

  _arm() {
    if (this._disposed || this.opts.tickMs <= 0) return;
    this._timer = this._timers.set(() => { this._timer = null; this._tickLoop(); }, this.opts.tickMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _tickLoop() {
    try { this.tick(); } catch (e) { this.lobby.log.error('[matchmaking] tick failed', e); }
    this._arm();
  }

  /** Stop the timer and tell everyone still queued that matchmaking is over. */
  shutdown() {
    this._disposed = true;
    if (this._timer) { this._timers.clear(this._timer); this._timer = null; }
    for (const pid of [...this.queue.keys()]) this._drop(pid, true);
  }

  /** @param {string} playerId @returns {boolean} */
  queued(playerId) { return this.queue.has(playerId); }

  /** Counters for /healthz (via lobby.stats). */
  stats() {
    const byDifficulty = {};
    for (const e of this.queue.values()) byDifficulty[e.difficulty] = (byDifficulty[e.difficulty] || 0) + 1;
    return { queued: this.queue.size, queuedByDifficulty: byDifficulty };
  }

  /**
   * `matchmaking.join { difficulty }`.
   * @param {import('./net.js').Session} session
   */
  join(session, { difficulty }) {
    const lobby = this.lobby;
    const pid = session.playerId;
    const cur = lobby.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    const existing = this.queue.get(pid);
    if (existing && existing.difficulty === difficulty) { this._pushState(pid); return OK; }
    if (!existing && this.queue.size >= this.opts.maxQueue) return fail(ERR.RATE, 'matchmaking queue is full');
    // joining matchmaking leaves a LOBBY room (spectator seats included), like room.create / room.join
    if (cur) lobby.removeMember(cur, pid);
    const prev = existing ? existing.difficulty : null;
    this.queue.set(pid, { playerId: pid, difficulty, joinedAt: this.now() });
    if (prev && prev !== difficulty) this._broadcastGroup(prev);
    this._broadcastGroup(difficulty);
    lobby.log.info(`[matchmaking] ${session.name} queued (${difficulty}, ${this.queue.size} waiting)`);
    return OK;
  }

  /** `matchmaking.leave` — idempotent. @param {string} playerId @returns {boolean} was queued */
  leave(playerId) {
    return this._drop(playerId, true);
  }

  /**
   * `matchmaking.startNow { withBots }` — the group is tired of waiting: take all queued players of
   * the requester's difficulty into one room and start the match immediately. With `withBots`, AI
   * teammates fill the empty seats to `teamSize`; without, the humans play short-handed.
   * @param {import('./net.js').Session} session
   */
  startNow(session, { withBots }) {
    const lobby = this.lobby;
    const pid = session.playerId;
    const e = this.queue.get(pid);
    if (!e) return fail(ERR.BAD_MSG, 'not in matchmaking queue');
    const difficulty = e.difficulty;
    // the whole difficulty group starts together
    const team = [];
    for (const en of this.queue.values()) {
      if (en.difficulty === difficulty) team.push(en);
    }
    team.sort((a, b) => a.joinedAt - b.joinedAt || (a.playerId < b.playerId ? -1 : 1));
    const members = [];
    for (const en of team) {
      const s = lobby.registry.byId(en.playerId);
      if (s && s.connected && !lobby.roomOf(s)) members.push({ entry: en, session: s });
      this.queue.delete(en.playerId);
    }
    if (members.length === 0) { this._broadcastGroup(difficulty); return fail(ERR.BAD_MSG, 'cannot start now'); }
    const host = members[0];
    let room = null;
    try {
      const r = lobby.create(host.session, { mode: 'coop', difficulty });
      if (r && r.error) throw new Error(`create: ${r.error}`);
      room = lobby.getRoom(host.session.roomCode);
      if (!room) throw new Error('create: no room');
      for (const m of members.slice(1)) {
        const jr = lobby.join(m.session, { code: room.code });
        if (jr && jr.error) lobby.log.warn(`[matchmaking] ${room.code} startNow join failed for ${m.session.name}: ${jr.error}`);
      }
      if (withBots) {
        while (room.seats.filter(Boolean).length < this.opts.teamSize) {
          if (!lobby.addBotDirect(room)) break;
        }
        lobby.broadcastState(room);
      }
      const st = lobby.startMatch(room);
      if (st && st.error) throw new Error(`startMatch: ${st.error}`);
    } catch (err) {
      lobby.log.error(`[matchmaking] startNow failed (${difficulty}):`, err && err.message ? err.message : err);
      if (room) for (const m of members) lobby.removeMember(room, m.entry.playerId);
      // back to the queue with the original wait
      const now = this.now();
      for (const m of members) {
        if (!this.queue.has(m.entry.playerId)) {
          this.queue.set(m.entry.playerId, { playerId: m.entry.playerId, difficulty, joinedAt: Math.min(m.entry.joinedAt, now) });
        }
        if (m.session.connected) sendSession(m.session, { t: 'matchmaking.state', inQueue: true, waiting: 0, difficulty });
      }
      this._broadcastGroup(difficulty);
      return fail(ERR.INTERNAL, 'failed to start');
    }
    for (const m of members) sendSession(m.session, { t: 'matchmaking.found', code: room.code });
    this._broadcastGroup(difficulty);
    const bots = room.seats.filter((s) => s && s.isBot).length;
    lobby.log.info(`[matchmaking] ${room.code} startNow (${difficulty}): ${members.length} humans${bots ? ` + ${bots} bots` : ''}, match started`);
    return OK;
  }

  /** The session's socket closed: the queue entry goes with it (a blip cancels matchmaking). */
  onDisconnect(session) {
    this._drop(session.playerId, false);
  }

  /** The session's reconnect window elapsed. */
  onExpire(session) {
    this._drop(session.playerId, false);
  }

  /**
   * Sweep stale entries, then seat complete teams (exactly `teamSize` real players, same difficulty)
   * in fresh rooms whose match starts immediately.
   */
  tick() {
    const lobby = this.lobby;
    const touched = new Set();
    for (const [pid, e] of this.queue) {
      const s = lobby.registry.byId(pid);
      if (!s || !s.connected || lobby.roomOf(s)) { this.queue.delete(pid); touched.add(e.difficulty); }
    }
    for (const d of touched) this._broadcastGroup(d);
    const groups = new Map();
    for (const e of this.queue.values()) {
      if (!groups.has(e.difficulty)) groups.set(e.difficulty, []);
      groups.get(e.difficulty).push(e);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.joinedAt - b.joinedAt || (a.playerId < b.playerId ? -1 : 1));
      let rest = list;
      while (rest.length >= this.opts.teamSize) {
        const team = rest.slice(0, this.opts.teamSize);
        rest = rest.slice(this.opts.teamSize);
        this._formTeam(team);
      }
      // fewer than teamSize: keep waiting — no timeout, no bots, no short teams.
    }
  }

  /**
   * Seat the team in a fresh co-op room and start its match immediately — no room lobby, no AI
   * teammates. A failure re-queues the humans with their original wait instead of throwing.
   * @param {{ playerId: string, difficulty: string, joinedAt: number }[]} team
   */
  _formTeam(team) {
    const lobby = this.lobby;
    const difficulty = team[0].difficulty;
    const members = [];
    for (const e of team) {
      const s = lobby.registry.byId(e.playerId);
      if (s && s.connected && !lobby.roomOf(s)) members.push({ entry: e, session: s });
      else this.queue.delete(e.playerId);
    }
    for (const m of members) this.queue.delete(m.entry.playerId);
    if (members.length === 0) { this._broadcastGroup(difficulty); return; }
    const host = members[0];
    let room = null;
    try {
      const r = lobby.create(host.session, { mode: 'coop', difficulty });
      if (r && r.error) throw new Error(`create: ${r.error}`);
      room = lobby.getRoom(host.session.roomCode);
      if (!room) throw new Error('create: no room');
      for (const m of members.slice(1)) {
        const jr = lobby.join(m.session, { code: room.code });
        if (jr && jr.error) lobby.log.warn(`[matchmaking] ${room.code} join failed for ${m.session.name}: ${jr.error}`);
      }
      // all humans, no bots: the match starts at once — the players never see the room lobby
      const st = lobby.startMatch(room);
      if (st && st.error) throw new Error(`startMatch: ${st.error}`);
    } catch (e) {
      lobby.log.error(`[matchmaking] forming a ${difficulty} team failed:`, e && e.message ? e.message : e);
      if (room) for (const m of members) lobby.removeMember(room, m.entry.playerId);
      const now = this.now();
      for (const m of members) {
        if (!this.queue.has(m.entry.playerId)) {
          this.queue.set(m.entry.playerId, { playerId: m.entry.playerId, difficulty, joinedAt: Math.min(m.entry.joinedAt, now) });
        }
        if (m.session.connected) sendSession(m.session, { t: 'matchmaking.state', inQueue: true, waiting: 0, difficulty });
      }
      this._broadcastGroup(difficulty);
      return;
    }
    for (const m of members) sendSession(m.session, { t: 'matchmaking.found', code: room.code });
    this._broadcastGroup(difficulty);
    lobby.log.info(`[matchmaking] ${room.code} formed (${difficulty}): ${members.length} humans, match started`);
  }

  /** Drop one entry; optionally tell its player and refresh its difficulty group. */
  _drop(playerId, notify) {
    const e = this.queue.get(playerId);
    if (!e) return false;
    this.queue.delete(playerId);
    if (notify) {
      const s = this.lobby.registry.byId(playerId);
      if (s && s.connected) sendSession(s, { t: 'matchmaking.state', inQueue: false });
    }
    this._broadcastGroup(e.difficulty);
    return true;
  }

  /** Push the current queue state to one player. */
  _pushState(playerId) {
    const e = this.queue.get(playerId);
    if (!e) return;
    const s = this.lobby.registry.byId(playerId);
    if (!s || !s.connected) return;
    const waiting = this._groupSize(e.difficulty);
    sendSession(s, { t: 'matchmaking.state', inQueue: true, waiting, difficulty: e.difficulty });
  }

  /** Push the current queue state to every queued player of one difficulty. */
  _broadcastGroup(difficulty) {
    const waiting = this._groupSize(difficulty);
    for (const e of this.queue.values()) {
      if (e.difficulty !== difficulty) continue;
      const s = this.lobby.registry.byId(e.playerId);
      if (s && s.connected) sendSession(s, { t: 'matchmaking.state', inQueue: true, waiting, difficulty });
    }
  }

  _groupSize(difficulty) {
    let n = 0;
    for (const e of this.queue.values()) if (e.difficulty === difficulty) n++;
    return n;
  }
}
