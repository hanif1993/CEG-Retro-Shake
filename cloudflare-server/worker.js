// =====================================================================
// INTEL CEG MYS RETRO NIGHT • SHAKE-it CHALLENGE — game server
// Cloudflare Worker + one Durable Object ("GameRoom") on the Workers Free plan.
//
// The server is the single source of truth:
//   - it runs the round timer itself (phones and big screen only display it)
//   - it keeps every player's score per round (survives page refreshes)
//   - a phone that connects late or reconnects gets the current round instantly
//   - only the big screen (with HOST_KEY) can start / reset the game
//
// Connections (WebSocket):
//   phone : wss://<worker>/ws?role=player&id=p_12345678&name=DiscoQueen%20(12345678)
//   screen: wss://<worker>/ws?role=host&key=<HOST_KEY>
// =====================================================================
import { DurableObject } from 'cloudflare:workers';

const TOTAL_ROUNDS = 3;
const ROUND_SECONDS = 30;
const END_GRACE_MS = 5000;        // keep accepting final scores for 5 s after TIME UP
const SYNC_MS = 1000;             // phones report their score once per second
const BOARD_PUSH_MS = 400;        // big screen refresh at most every 0.4 s
const SAVE_MS = 2000;             // save scores to storage at most every 2 s during a round
const MAX_SHAKES_PER_SEC = 14;    // phone counts max 1 shake / 75 ms (~13.3/s); more = fake
const MAX_ROUND_SCORE = Math.ceil(ROUND_SECONDS * MAX_SHAKES_PER_SEC) + 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      // Everyone joins the same game room
      const room = env.GAME.get(env.GAME.idFromName('ceg-retro-night'));
      return room.fetch(request);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response('CEG Retro Shake server is running');
  }
};

function newGameId() {
  return 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function freshState() {
  return {
    gameId: newGameId(),
    phase: 'standby',        // standby | live | tally | between | finished
    round: 1,                // round being played, or the next one to start
    roundStartedAt: 0,
    roundEndsAt: 0,
    players: {}              // id -> { name, rounds: { "1": n, ... }, lastRound }
  };
}

const totalOf = (p) => Object.values(p.rounds || {}).reduce((s, n) => s + (Number(n) || 0), 0);

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.state = null;
    this.lastBoardPush = 0;
    this.boardTimer = null;
    this.lastSave = 0;
    this.saveTimer = null;
    this.dirty = false;
    // Keep-alive pings from phones are answered without waking the object (free)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Load saved game (after a restart or wake-up from hibernation)
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || freshState();
    });
  }

  // ---------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------
  async save(force = false) {
    const sinceLast = Date.now() - this.lastSave;
    if (!force && sinceLast < SAVE_MS) {
      // Throttled: make sure the latest state is still written a little later
      this.dirty = true;
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => { this.saveTimer = null; if (this.dirty) this.save(true); }, SAVE_MS - sinceLast);
      }
      return;
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.lastSave = Date.now();
    this.dirty = false;
    await this.ctx.storage.put('state', this.state);
  }

  // ---------------------------------------------------------------
  // New connections
  // ---------------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      const key = url.searchParams.get('key') || '';
      this.ctx.acceptWebSocket(server, ['host']);
      if (!this.env.HOST_KEY || key !== this.env.HOST_KEY) {
        server.send(JSON.stringify({ t: 'error', reason: this.env.HOST_KEY ? 'bad_key' : 'no_host_key_set' }));
        server.close(4001, 'Wrong host key');
        return new Response(null, { status: 101, webSocket: client });
      }
      server.serializeAttachment({ role: 'host' });
      server.send(JSON.stringify(this.boardMessage()));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Player
    const id = String(url.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
    const name = String(url.searchParams.get('name') || 'Unknown').slice(0, 40);
    if (!id) return new Response('Missing player id', { status: 400 });
    this.ctx.acceptWebSocket(server, ['player']);
    server.serializeAttachment({ role: 'player', id, name });
    this.getOrCreatePlayer(id, name);
    await this.save();
    server.send(JSON.stringify(this.welcomeMessage(id)));
    this.pushBoard(false);
    return new Response(null, { status: 101, webSocket: client });
  }

  getOrCreatePlayer(id, name) {
    const s = this.state;
    if (!s.players[id]) s.players[id] = { name, rounds: {}, lastRound: 0 };
    else if (name) s.players[id].name = name;
    return s.players[id];
  }

  welcomeMessage(id) {
    const s = this.state;
    const p = s.players[id];
    return {
      t: 'welcome',
      gameId: s.gameId,
      phase: s.phase,
      round: s.round,
      timeLeft: s.phase === 'live' ? Math.max(0, (s.roundEndsAt - Date.now()) / 1000) : 0,
      syncMs: SYNC_MS,
      rounds: p ? p.rounds : {}
    };
  }

  // ---------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 4000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const att = ws.deserializeAttachment() || {};

    if (att.role === 'host') {
      if (msg.t === 'start') await this.startRound();
      else if (msg.t === 'reset') await this.resetGame();
      else if (msg.t === 'export') ws.send(JSON.stringify(this.resultsMessage()));
      else if (msg.t === 'board') ws.send(JSON.stringify(this.boardMessage()));
      return;
    }

    if (att.role === 'player') {
      if (msg.t === 'hello') { ws.send(JSON.stringify(this.welcomeMessage(att.id))); return; }
      if (msg.t === 'score') {
        await this.acceptScore(att, msg);
        // Receipt: lets the phone notice a dead connection within seconds (outgoing messages are free)
        try { ws.send('ok'); } catch (e) {}
      }
    }
  }

  async acceptScore(att, msg) {
    const s = this.state;
    if (msg.gameId !== s.gameId) return;
    const p = this.getOrCreatePlayer(att.id, att.name);
    let changed = false;

    // Current round: only while live or during the short tally window
    const round = Number(msg.round);
    if ((s.phase === 'live' || s.phase === 'tally') && round === s.round) {
      const elapsedSec = Math.min(ROUND_SECONDS + 2, (Date.now() - s.roundStartedAt) / 1000 + 1);
      const maxAllowed = Math.ceil(elapsedSec * MAX_SHAKES_PER_SEC) + 5;
      const score = Math.max(0, Math.min(Math.floor(Number(msg.score) || 0), maxAllowed));
      if (score > (p.rounds[round] || 0)) { p.rounds[round] = score; changed = true; }
      if (p.lastRound !== round) { p.lastRound = round; changed = true; }
    }

    // Late correction for EARLIER rounds (final score was lost to a network drop)
    if (msg.all && typeof msg.all === 'object' && s.phase !== 'finished' && s.phase !== 'standby') {
      for (const [k, v] of Object.entries(msg.all)) {
        const r = Number(k);
        if (!(r >= 1 && r < s.round)) continue;
        const val = Math.max(0, Math.min(Math.floor(Number(v) || 0), MAX_ROUND_SCORE));
        if (val > (p.rounds[r] || 0)) { p.rounds[r] = val; changed = true; }
      }
    }

    if (changed) {
      await this.save(s.phase !== 'live');   // during a live round: at most every 2 s
      this.pushBoard(false);
    }
  }

  // ---------------------------------------------------------------
  // Round flow (timer runs on the server with an alarm)
  // ---------------------------------------------------------------
  async startRound() {
    const s = this.state;
    if (s.phase !== 'standby' && s.phase !== 'between') return;
    s.phase = 'live';
    s.roundStartedAt = Date.now();
    s.roundEndsAt = s.roundStartedAt + ROUND_SECONDS * 1000;
    for (const p of Object.values(s.players)) {
      p.rounds[s.round] = 0;
      if (p.lastRound === s.round) p.lastRound = 0;
    }
    await this.save(true);
    await this.ctx.storage.setAlarm(s.roundEndsAt);
    this.broadcastPlayers({ t: 'start', gameId: s.gameId, round: s.round, timeLeft: ROUND_SECONDS, syncMs: SYNC_MS });
    this.pushBoard(true);
  }

  async alarm() {
    const s = this.state;
    if (s.phase === 'live') {
      if (Date.now() < s.roundEndsAt - 20) { await this.ctx.storage.setAlarm(s.roundEndsAt); return; }
      s.phase = 'tally';
      await this.save(true);
      await this.ctx.storage.setAlarm(Date.now() + END_GRACE_MS);
      this.broadcastPlayers({ t: 'end', gameId: s.gameId, round: s.round });
      this.pushBoard(true);
    } else if (s.phase === 'tally') {
      if (s.round < TOTAL_ROUNDS) { s.round++; s.phase = 'between'; }
      else s.phase = 'finished';
      await this.save(true);
      this.pushBoard(true);
    }
  }

  async resetGame() {
    const old = this.state;
    this.state = freshState();
    // Phones still connected stay registered (no need to re-enter their nickname)
    for (const ws of this.ctx.getWebSockets('player')) {
      const att = ws.deserializeAttachment();
      if (att && att.id) this.getOrCreatePlayer(att.id, att.name);
    }
    await this.ctx.storage.deleteAlarm();
    await this.save(true);
    this.broadcastPlayers({ t: 'reset', gameId: this.state.gameId, oldGameId: old.gameId });
    this.pushBoard(true);
  }

  // ---------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------
  broadcastPlayers(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets('player')) {
      try { ws.send(msg); } catch (e) {}
    }
  }

  sortedPlayers() {
    return Object.values(this.state.players).sort((a, b) =>
      (totalOf(b) - totalOf(a)) || String(a.name).localeCompare(String(b.name)));
  }

  boardMessage() {
    const s = this.state;
    const all = Object.values(s.players);
    return {
      t: 'board',
      gameId: s.gameId,
      phase: s.phase,
      round: s.round,
      totalRounds: TOTAL_ROUNDS,
      roundSeconds: ROUND_SECONDS,
      timeLeftMs: s.phase === 'live' ? Math.max(0, s.roundEndsAt - Date.now()) : 0,
      players: all.length,
      online: this.ctx.getWebSockets('player').length,
      reporting: all.filter((p) => p.lastRound === s.round).length,
      top: this.sortedPlayers().slice(0, 10).map((p) => ({ name: p.name, total: totalOf(p), roundScore: p.rounds[s.round] || 0 }))
    };
  }

  resultsMessage() {
    return {
      t: 'results',
      gameId: this.state.gameId,
      totalRounds: TOTAL_ROUNDS,
      players: this.sortedPlayers().map((p) => ({ name: p.name, rounds: p.rounds, total: totalOf(p) }))
    };
  }

  // Big screen update — immediate for round changes, otherwise at most every BOARD_PUSH_MS
  pushBoard(immediate) {
    const hosts = this.ctx.getWebSockets('host');
    if (hosts.length === 0) return;
    const send = () => {
      this.boardTimer = null;
      this.lastBoardPush = Date.now();
      const msg = JSON.stringify(this.boardMessage());
      for (const ws of this.ctx.getWebSockets('host')) { try { ws.send(msg); } catch (e) {} }
    };
    if (immediate) { if (this.boardTimer) clearTimeout(this.boardTimer); send(); return; }
    if (this.boardTimer) return;
    const wait = Math.max(0, BOARD_PUSH_MS - (Date.now() - this.lastBoardPush));
    this.boardTimer = setTimeout(send, wait);
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) {}
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'player') this.pushBoard(false);
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (e) {}
  }
}
