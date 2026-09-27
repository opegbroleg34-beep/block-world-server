'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Game = require('./game-rules');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'world-data.json');
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM || 8);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const BODY_LIMIT = 256 * 1024;
const PLAYER_STALE_MS = 20_000;
const ROOM_EXPIRE_MS = 24 * 60 * 60 * 1000;
const DROP_EXPIRE_MS = 10 * 60 * 1000;
const CHAT_MAX_LENGTH = 120;
const CHAT_RATE_MS = 1200;
const CHAT_KEEP = 50;

const rooms = new Map();
const tokenToRoom = new Map();
let saveTimer = null;

function cleanString(value, max = 32) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function safeMode(value) { return value === 'survival' ? 'survival' : 'creative'; }
function now() { return Date.now(); }
function roomCode() {
  for (let i = 0; i < 1000; i++) {
    const code = crypto.randomBytes(6).toString('hex').toUpperCase();
    if (!rooms.has(code)) return code;
  }
  throw new Error('Не удалось создать код комнаты');
}
function playerToken() { return crypto.randomBytes(24).toString('hex'); }
function clampNumber(v, min, max, fallback = 0) {
  v = Number(v);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}
function normalizePosition(value, fallback = [31.5, 12, 31.5]) {
  if (!Game.validPos(value)) return fallback.slice();
  return [
    clampNumber(value[0], -999999999, 999999999, fallback[0]),
    clampNumber(value[1], 0, 31.999, fallback[1]),
    clampNumber(value[2], -999999999, 999999999, fallback[2]),
  ];
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function sendError(res, status, message) { sendJson(res, status, { error: message }); }

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Некорректный JSON'), { status: 400 }); }
}

function makeRoom(mode, title = '') {
  const code = roomCode();
  const room = {
    code,
    title: cleanString(title, 30) || 'Открытый мир',
    state: Game.create(safeMode(mode)),
    members: {},
    players: new Map(),
    chat: [],
    chatSeq: 0,
    chatLastAt: new Map(),
    createdAt: now(),
    updatedAt: now(),
  };
  rooms.set(code, room);
  return room;
}

function activePlayers(room, exceptToken = null) {
  const t = now();
  const out = [];
  for (const [token, p] of room.players) {
    if (token === exceptToken) continue;
    if (t - p.lastSeen > PLAYER_STALE_MS) continue;
    const bag = Game.player(room.state, token, t);
    out.push({
      id: token.slice(0, 12),
      name: p.name,
      x: p.position[0], y: p.position[1], z: p.position[2],
      yaw: p.yaw, pitch: p.pitch,
      held: Game.equipped(bag, p.slot),
      crouch: !!p.crouch,
    });
  }
  return out;
}

function activeCount(room) {
  const t = now();
  let n = 0;
  for (const p of room.players.values()) if (t - p.lastSeen <= PLAYER_STALE_MS) n++;
  return n;
}

function roomList() {
  return [...rooms.values()]
    .map(room => ({
      code: room.code,
      title: room.title || 'Открытый мир',
      mode: room.state.mode,
      players: activeCount(room),
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      updatedAt: room.updatedAt,
    }))
    .filter(r => r.players > 0)
    .sort((a, b) => b.players - a.players || b.updatedAt - a.updatedAt)
    .slice(0, 50);
}

function chatAfter(room, since = 0) {
  since = Number.isFinite(Number(since)) ? Number(since) : 0;
  return (room.chat || []).filter(m => m.id > since).slice(-30);
}

function cleanChatText(value) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.slice(0, CHAT_MAX_LENGTH);
  if (/(?:https?:\/\/|www\.)/i.test(text)) throw new Error('Ссылки в чате отключены');
  return text;
}

function findRoomByToken(token) {
  token = cleanString(token, 128);
  if (!token) return null;
  const direct = tokenToRoom.get(token);
  if (direct) {
    const room = rooms.get(direct);
    if (room && room.members[token]) return room;
    tokenToRoom.delete(token);
  }
  for (const room of rooms.values()) {
    if (room.members[token] || room.state.bags?.[token]) {
      tokenToRoom.set(token, room.code);
      if (!room.members[token]) room.members[token] = { name: 'Игрок' };
      return room;
    }
  }
  return null;
}

function ensurePlayer(room, token) {
  let p = room.players.get(token);
  const meta = room.members[token] || { name: 'Игрок' };
  if (!p) {
    p = {
      name: cleanString(meta.name, 18) || 'Игрок',
      position: Array.isArray(meta.position) ? normalizePosition(meta.position) : [31.5, Game.height(31,31) + 2.7, 31.5],
      yaw: Number(meta.yaw) || 0.6,
      pitch: Number(meta.pitch) || -0.13,
      slot: Number.isInteger(meta.slot) ? Math.max(0, Math.min(8, meta.slot)) : 0,
      crouch: !!meta.crouch,
      active: false,
      lastSeen: now(),
      lastTickRun: 0,
    };
    room.players.set(token, p);
  }
  return p;
}

function updatePlayerFromRequest(room, token, body) {
  const p = ensurePlayer(room, token);
  if (body.position !== undefined) p.position = normalizePosition(body.position, p.position);
  if (body.yaw !== undefined) p.yaw = clampNumber(body.yaw, -1e9, 1e9, p.yaw);
  if (body.pitch !== undefined) p.pitch = clampNumber(body.pitch, -1.57, 1.57, p.pitch);
  if (Number.isInteger(body.slot)) p.slot = Math.max(0, Math.min(8, body.slot));
  if (body.crouch !== undefined) p.crouch = !!body.crouch;
  if (body.active !== undefined) p.active = !!body.active;
  p.lastSeen = now();
  room.members[token] = {
    name: p.name, position: p.position, yaw: p.yaw, pitch: p.pitch,
    slot: p.slot, crouch: p.crouch,
  };
  return p;
}

function changesSince(room, since) {
  since = Number.isFinite(Number(since)) ? Number(since) : 0;
  return Object.values(room.state.blocks || {})
    .filter(c => Number(c.id || 0) > since)
    .sort((a, b) => (a.id || 0) - (b.id || 0));
}

function gameSnapshot(room, token, since = 0, extra = {}) {
  const bag = Game.player(room.state, token, now());
  return {
    ...extra,
    room: room.code,
    token,
    revision: room.state.rev,
    mode: room.state.mode,
    bag,
    chests: room.state.chests || {},
    drops: room.state.drops || {},
    changes: changesSince(room, since),
    players: activePlayers(room, token),
    serverTime: now(),
  };
}

function cleanupDrops(room) {
  const t = now();
  for (const [id, d] of Object.entries(room.state.drops || {})) {
    if (t - Number(d.born || t) > DROP_EXPIRE_MS) delete room.state.drops[id];
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveAll, 1500);
  saveTimer.unref?.();
}

function saveAll() {
  saveTimer = null;
  const serial = { version: 1, rooms: {} };
  for (const [code, room] of rooms) {
    serial.rooms[code] = {
      title: room.title,
      state: room.state,
      members: room.members,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(serial));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.warn('Save warning:', e.message);
  }
}

function loadAll() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [code, saved] of Object.entries(raw.rooms || {})) {
      if (!/^[A-F0-9]{12}$/.test(code)) continue;
      const room = {
        code,
        title: cleanString(saved.title, 30) || 'Открытый мир',
        state: saved.state || Game.create('creative'),
        members: saved.members || {},
        players: new Map(),
        chat: [],
        chatSeq: 0,
        chatLastAt: new Map(),
        createdAt: Number(saved.createdAt) || now(),
        updatedAt: Number(saved.updatedAt) || now(),
      };
      rooms.set(code, room);
      for (const token of Object.keys(room.members)) tokenToRoom.set(token, code);
    }
    console.log(`Loaded ${rooms.size} room(s)`);
  } catch (e) {
    console.warn('Load warning:', e.message);
  }
}

function prune() {
  const t = now();
  for (const [code, room] of rooms) {
    for (const [token, p] of room.players) {
      if (t - p.lastSeen > PLAYER_STALE_MS * 3) room.players.delete(token);
    }
    cleanupDrops(room);
    const anyRecent = [...room.players.values()].some(p => t - p.lastSeen <= PLAYER_STALE_MS);
    if (!anyRecent && t - room.updatedAt > ROOM_EXPIRE_MS && rooms.size > 50) {
      rooms.delete(code);
      for (const token of Object.keys(room.members)) tokenToRoom.delete(token);
    }
  }
}
setInterval(prune, 60_000).unref();

async function handleJoin(req, res, body) {
  const create = !!body.create;
  const requestedName = cleanString(body.name, 18) || 'Игрок';
  let room;
  if (create) {
    if (rooms.size >= MAX_ROOMS) return sendError(res, 503, 'Сейчас создано слишком много комнат');
    const title = cleanString(body.serverName, 30) || ('Мир ' + requestedName);
    room = makeRoom(body.mode, title);
  } else {
    const code = cleanString(body.room, 12).toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(code)) return sendError(res, 400, 'Код комнаты должен состоять из 12 символов');
    room = rooms.get(code);
    if (!room) return sendError(res, 404, 'Комната не найдена');
  }

  const t = now();
  const currentActive = [...room.players.entries()].filter(([,p]) => t - p.lastSeen <= PLAYER_STALE_MS);
  const resume = cleanString(body.resume, 128);
  const canResume = resume && (room.members[resume] || room.state.bags?.[resume]);
  if (!canResume && currentActive.length >= MAX_PLAYERS_PER_ROOM) return sendError(res, 409, 'Комната заполнена');

  const token = canResume ? resume : playerToken();
  const name = requestedName || room.members[token]?.name || 'Игрок';
  room.members[token] = { ...(room.members[token] || {}), name };
  tokenToRoom.set(token, room.code);
  const p = ensurePlayer(room, token);
  p.name = name;
  p.lastSeen = t;
  p.active = false;
  Game.player(room.state, token, t);
  room.updatedAt = t;
  scheduleSave();
  return sendJson(res, 200, gameSnapshot(room, token, 0, { chat: (room.chat || []).slice(-20) }));
}

async function handleSync(req, res, body) {
  const token = cleanString(body.token, 128);
  const room = findRoomByToken(token);
  if (!room) return sendError(res, 401, 'Сессия комнаты не найдена. Войди в комнату ещё раз');
  const p = updatePlayerFromRequest(room, token, body);
  const t = now();
  if (t - p.lastTickRun >= 900) {
    try {
      Game.run(room.state, token, { type: 'tick', active: !!body.active }, t, []);
      p.lastTickRun = t;
    } catch (e) {
      return sendError(res, 400, e.message || 'Ошибка состояния игрока');
    }
  }
  Game.grow(room.state, t);
  cleanupDrops(room);
  room.updatedAt = t;
  scheduleSave();
  return sendJson(res, 200, gameSnapshot(room, token, body.since, { chat: chatAfter(room, body.chatSince) }));
}

async function handleAction(req, res, body) {
  const token = cleanString(body.token, 128);
  const room = findRoomByToken(token);
  if (!room) return sendError(res, 401, 'Сессия комнаты не найдена. Войди в комнату ещё раз');
  const p = updatePlayerFromRequest(room, token, body);
  const others = activePlayers(room, token).map(o => [o.x, o.y, o.z]);
  let result;
  try {
    const action = { ...body };
    delete action.token;
    delete action.since;
    result = Game.run(room.state, token, action, now(), others) || {};
    Game.grow(room.state, now());
  } catch (e) {
    return sendError(res, 400, e.message || 'Действие отклонено сервером');
  }
  p.lastSeen = now();
  room.updatedAt = now();
  scheduleSave();
  return sendJson(res, 200, gameSnapshot(room, token, body.since, result));
}


async function handleChat(req, res, body) {
  const token = cleanString(body.token, 128);
  const room = findRoomByToken(token);
  if (!room) return sendError(res, 401, 'Сессия комнаты не найдена. Войди в комнату ещё раз');
  const p = ensurePlayer(room, token);
  p.lastSeen = now();
  let text;
  try { text = cleanChatText(body.text); }
  catch (e) { return sendError(res, 400, e.message); }
  if (!text) return sendError(res, 400, 'Сообщение пустое');

  const t = now();
  const last = room.chatLastAt.get(token) || 0;
  if (t - last < CHAT_RATE_MS) return sendError(res, 429, 'Пиши чуть медленнее');
  room.chatLastAt.set(token, t);

  const message = {
    id: ++room.chatSeq,
    name: cleanString(p.name, 18) || 'Игрок',
    text,
    time: t,
  };
  room.chat.push(message);
  if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
  room.updatedAt = t;
  return sendJson(res, 200, { ok: true, message });
}

async function handleLeave(req, res, body) {
  const token = cleanString(body.token, 128);
  const room = findRoomByToken(token);
  if (room) {
    const p = room.players.get(token);
    if (p) {
      room.members[token] = {
        name: p.name, position: p.position, yaw: p.yaw, pitch: p.pitch,
        slot: p.slot, crouch: p.crouch,
      };
      room.players.delete(token);
    }
    room.updatedAt = now();
    scheduleSave();
  }
  return sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/api/rooms') {
      return sendJson(res, 200, { rooms: roomList(), time: now() });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      return sendJson(res, 200, {
        ok: true,
        service: 'Block World multiplayer server',
        rooms: rooms.size,
        activePlayers: [...rooms.values()].reduce((n, r) => n + activePlayers(r).length, 0),
        time: now(),
      });
    }
    if (req.method !== 'POST') return sendError(res, 405, 'Метод не поддерживается');
    const body = await readJson(req);
    if (req.url === '/api/join') return handleJoin(req, res, body);
    if (req.url === '/api/sync') return handleSync(req, res, body);
    if (req.url === '/api/action') return handleAction(req, res, body);
    if (req.url === '/api/chat') return handleChat(req, res, body);
    if (req.url === '/api/leave') return handleLeave(req, res, body);
    return sendError(res, 404, 'API-метод не найден');
  } catch (e) {
    console.error(e);
    return sendError(res, e.status || 500, e.status ? e.message : 'Ошибка сервера');
  }
});

loadAll();
server.listen(PORT, HOST, () => {
  console.log(`Block World server: http://${HOST}:${PORT}`);
  console.log(`Health check: /health`);
});

function shutdown() {
  try { saveAll(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
