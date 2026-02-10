/**
 * server.js — SAYRA FULL (Multi-file) — 1v1 Match + Text + Voice + Icebreaker + Admin page
 * =====================================================================================
 * Files:
 *   - public/index.html  (loads /app.js)
 *   - public/app.js
 *   - public/admin.html  (loads /admin.js)
 *   - public/admin.js
 *
 * ✅ 1v1 Matchmaking: level + gender (same key)
 * ✅ Strict room lock: max 2 users
 * ✅ Text chat + typing + read receipts (basic)
 * ✅ Voice: WebRTC signaling (offer/answer/ice)
 * ✅ Icebreaker: matchdan keyin 3 savol, ← → bilan synced
 * ✅ Admin: /admin sahifasi + socket admin panel (live snapshot)
 * ✅ Admin HTTP API: /admin/stats, /admin/action (x-admin-token)
 */

"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "2837198642hdst721eg";

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const GENDERS = ["male", "female"];
const MAX_ROOM_USERS = 2;

const MSG_MAX_LEN = 900;
const NAME_MAX_LEN = 24;

// anti-spam
const RATE_WINDOW_MS = 5000;
const RATE_MAX_MSG = 9;
const JOIN_COOLDOWN_MS = 1200;
const TYPING_THROTTLE_MS = 250;

// moderation
const REPORT_TO_MUTE = 3;
const AUTO_MUTE_MS = 5 * 60 * 1000;

// history/log
const HISTORY_LIMIT = 80;
const LOG_LIMIT = 300;

// ---------------- ICEBREAKER BANK ----------------
const QUESTION_BANK = [
  "What is your hobby?",
  "What do you do on weekends?",
  "What kind of music do you like?",
  "Do you prefer tea or coffee? Why?",
  "What was the last movie you watched?",
  "What is your favorite food?",
  "Do you like living in the city or countryside?",
  "What is one goal you have this year?",
  "What do you usually do after school/work?",
  "What app do you use the most?",
  "What sport do you like?",
  "Do you like reading books? Which genre?",
  "What place do you want to visit?",
  "What makes you happy?",
  "What is something you are learning now?"
];

function pick3Questions() {
  const copy = QUESTION_BANK.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, 3);
}

// ---------------- APP ----------------
const app = express();
app.use(express.json({ limit: "256kb" }));

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"],
  cors: { origin: "*" },
});

// ---------------- STATE ----------------
const waiting = new Map(); // key -> [{socketId, clientId, name, level, gender, joinedAt}]
const rooms = new Map();   // roomId -> {a,b,key,createdAt,lastActiveAt,history,lock, ice:{questions,index}}
const socketMeta = new Map(); // socketId -> meta
const clientIndex = new Map(); // clientId -> socketId

const bannedClients = new Map(); // clientId -> until
const bannedIps = new Map(); // ip -> until

const metrics = {
  startedAt: Date.now(),
  connections: 0,
  disconnections: 0,
  matches: 0,
  messages: 0,
  reports: 0,
  mutes: 0,
  bans: 0,
  voiceOffers: 0,
  voiceAnswers: 0,
  voiceIce: 0,
  iceShown: 0,
  iceNextPrev: 0
};

let onlineUsers = 0;

const logs = [];
function addLog(type, data) {
  logs.push({ t: Date.now(), type, data });
  if (logs.length > LOG_LIMIT) logs.shift();
}

// ---------------- UTILS ----------------
const now = () => Date.now();
const uid = (n = 10) => crypto.randomBytes(n).toString("hex");

function clampText(x, max) {
  return String(x ?? "").replace(/\r/g, "").trim().replace(/\s+/g, " ").slice(0, max);
}
function safeMsg(x) {
  return String(x ?? "").replace(/\r/g, "").slice(0, MSG_MAX_LEN);
}
function isValidLevel(x) { return LEVELS.includes(String(x).toUpperCase()); }
function isValidGender(x) { return GENDERS.includes(String(x).toLowerCase()); }
function keyOf(level, gender) { return `${String(level).toUpperCase()}__${String(gender).toLowerCase()}`; }
function createRoomId() { return `room_${uid(6)}_${now().toString(16)}`; }

function ensureQueue(key) {
  if (!waiting.has(key)) waiting.set(key, []);
  return waiting.get(key);
}

function removeFromWaitingSocket(socketId) {
  for (const [k, q] of waiting.entries()) {
    const i = q.findIndex(e => e.socketId === socketId);
    if (i !== -1) {
      q.splice(i, 1);
      if (!q.length) waiting.delete(k);
      return true;
    }
  }
  return false;
}
function removeFromWaitingClient(clientId) {
  for (const [k, q] of waiting.entries()) {
    const i = q.findIndex(e => e.clientId === clientId);
    if (i !== -1) {
      q.splice(i, 1);
      if (!q.length) waiting.delete(k);
      return true;
    }
  }
  return false;
}

function roomSize(roomId) {
  const r = rooms.get(roomId);
  if (!r) return 0;
  return (r.a ? 1 : 0) + (r.b ? 1 : 0);
}
function otherSocket(roomId, mySocketId) {
  const r = rooms.get(roomId);
  if (!r) return null;
  if (r.a === mySocketId) return r.b || null;
  if (r.b === mySocketId) return r.a || null;
  return null;
}

function queueStats() {
  const out = {};
  for (const L of LEVELS) for (const G of GENDERS) {
    const k = keyOf(L, G);
    out[k] = (waiting.get(k) || []).length;
  }
  return out;
}

function emitGlobalStats() {
  io.emit("global_stats", {
    ts: now(),
    onlineUsers,
    rooms: rooms.size,
    queue: queueStats(),
    metrics: {
      connections: metrics.connections,
      matches: metrics.matches,
      messages: metrics.messages,
      reports: metrics.reports,
      iceShown: metrics.iceShown
    }
  });
}

function status(socket, type, message, extra = {}) {
  socket.emit("status", { ts: now(), type, message, ...extra });
}

function isBanned(clientId, ip) {
  const t = now();
  const bc = bannedClients.get(clientId);
  if (bc && t < bc) return { ok: false, kind: "client", until: bc };
  const bi = bannedIps.get(ip);
  if (bi && t < bi) return { ok: false, kind: "ip", until: bi };
  return { ok: true };
}

function canSendMessage(socketId) {
  const m = socketMeta.get(socketId);
  if (!m) return { ok: false, reason: "no_meta" };

  if (m.mutedUntil && now() < m.mutedUntil) {
    return { ok: false, reason: "muted", seconds: Math.ceil((m.mutedUntil - now()) / 1000) };
  }

  const t = now();
  const arr = m.msgTimes || [];
  const keep = arr.filter(x => t - x <= RATE_WINDOW_MS);
  keep.push(t);
  m.msgTimes = keep;

  if (keep.length > RATE_MAX_MSG) return { ok: false, reason: "rate" };
  return { ok: true };
}

function destroyRoom(roomId, reason = "closed") {
  const r = rooms.get(roomId);
  if (!r) return;
  io.to(roomId).emit("room_closed", { roomId, reason, ts: now() });
  rooms.delete(roomId);
  addLog("room_destroy", { roomId, reason });
}

function pushHistory(roomId, msg) {
  const r = rooms.get(roomId);
  if (!r) return;
  r.history.push(msg);
  if (r.history.length > HISTORY_LIMIT) r.history.shift();
  r.lastActiveAt = now();
}

// -------- ICEBREAKER --------
function emitIcebreaker(roomId) {
  const r = rooms.get(roomId);
  if (!r?.ice) return;
  io.to(roomId).emit("icebreaker", {
    roomId,
    questions: r.ice.questions,
    index: r.ice.index,
    total: r.ice.questions.length,
    ts: now()
  });
  metrics.iceShown++;
}

function iceNav(roomId, dir) {
  const r = rooms.get(roomId);
  if (!r?.ice) return;
  const max = r.ice.questions.length - 1;
  if (dir === "next") r.ice.index = Math.min(max, r.ice.index + 1);
  if (dir === "prev") r.ice.index = Math.max(0, r.ice.index - 1);
  metrics.iceNextPrev++;
  emitIcebreaker(roomId);
}

// ---------------- ADMIN HTTP API ----------------
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: now(),
    uptimeSec: Math.floor((now() - metrics.startedAt) / 1000),
    onlineUsers,
    rooms: rooms.size
  });
});

app.get("/metrics-lite", (req, res) => {
  res.json({ ok: true, ts: now(), onlineUsers, rooms: rooms.size, queue: queueStats(), metrics });
});

app.get("/admin/stats", requireAdmin, (req, res) => {
  const sockets = Array.from(socketMeta.entries()).map(([sid, m]) => ({
    socketId: sid,
    clientId: m.clientId,
    name: m.name,
    level: m.level,
    gender: m.gender,
    roomId: m.roomId,
    reports: m.reports || 0,
    mutedUntil: m.mutedUntil || 0,
    ip: m.ip
  }));

  const roomDump = Array.from(rooms.entries()).map(([rid, r]) => ({
    roomId: rid,
    key: r.key,
    a: r.a,
    b: r.b,
    size: roomSize(rid),
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
    lock: r.lock,
    iceIndex: r.ice?.index ?? null,
    ice: r.ice?.questions ?? null,
    historyLen: r.history?.length || 0
  }));

  res.json({
    ok: true,
    ts: now(),
    onlineUsers,
    rooms: rooms.size,
    queue: queueStats(),
    metrics,
    sockets,
    roomDump,
    bannedClients: Array.from(bannedClients.entries()),
    bannedIps: Array.from(bannedIps.entries()),
    logs
  });
});

app.post("/admin/action", requireAdmin, (req, res) => {
  const action = String(req.body?.action || "");
  const targetSocketId = String(req.body?.targetSocketId || "");
  const minutes = Number(req.body?.minutes || 5);
  const ip = String(req.body?.ip || "");
  const durMs = Math.max(1, minutes) * 60 * 1000;

  const targetSock = io.sockets.sockets.get(targetSocketId);
  const tm = socketMeta.get(targetSocketId);

  if (action === "kick") {
    if (!targetSock) return res.json({ ok: false, error: "socket_not_found" });
    status(targetSock, "error", "Admin sizni chiqardi.");
    targetSock.disconnect(true);
    addLog("admin_kick", { targetSocketId });
    return res.json({ ok: true });
  }

  if (action === "mute") {
    if (!tm) return res.json({ ok: false, error: "meta_not_found" });
    tm.mutedUntil = now() + durMs;
    metrics.mutes++;
    if (targetSock) status(targetSock, "error", `Admin sizni ${minutes} min mute qildi.`);
    addLog("admin_mute", { targetSocketId, minutes });
    return res.json({ ok: true });
  }

  if (action === "ban_client") {
    if (!tm) return res.json({ ok: false, error: "meta_not_found" });
    bannedClients.set(tm.clientId, now() + durMs);
    metrics.bans++;
    addLog("admin_ban_client", { clientId: tm.clientId, minutes });
    if (targetSock) {
      status(targetSock, "error", `Siz ${minutes} min BAN bo‘ldingiz.`);
      targetSock.disconnect(true);
    }
    return res.json({ ok: true });
  }

  if (action === "ban_ip") {
    if (!ip) return res.json({ ok: false, error: "ip_required" });
    bannedIps.set(ip, now() + durMs);
    metrics.bans++;
    addLog("admin_ban_ip", { ip, minutes });
    return res.json({ ok: true });
  }

  return res.json({ ok: false, error: "unknown_action" });
});

// ---------------- SOCKETS ----------------
io.on("connection", (socket) => {
  metrics.connections++;
  onlineUsers++;
  emitGlobalStats();

  const ip = socket.handshake.address || "unknown";
  addLog("connect", { socketId: socket.id, ip });
  status(socket, "connected", "✅ Ulandingiz.");

  socket.on("hello", (payload) => {
    const clientId = clampText(payload?.clientId, 80) || ("c_" + uid(8));
    const ban = isBanned(clientId, ip);
    if (!ban.ok) {
      status(socket, "error", "⛔ Siz vaqtincha BAN bo‘lgansiz.");
      socket.disconnect(true);
      return;
    }

    const prevSocketId = clientIndex.get(clientId);
    if (prevSocketId && prevSocketId !== socket.id) {
      const prev = io.sockets.sockets.get(prevSocketId);
      try { prev?.disconnect(true); } catch {}
    }
    clientIndex.set(clientId, socket.id);

    if (!socketMeta.has(socket.id)) {
      socketMeta.set(socket.id, {
        clientId,
        name: null,
        level: null,
        gender: null,
        key: null,
        roomId: null,
        msgTimes: [],
        lastJoinAt: 0,
        mutedUntil: 0,
        reports: 0,
        ip
      });
    } else {
      socketMeta.get(socket.id).clientId = clientId;
      socketMeta.get(socket.id).ip = ip;
    }

    socket.emit("hello_ok", { clientId, ts: now() });
  });

  socket.on("find_partner", (payload) => {
    const meta0 = socketMeta.get(socket.id);
    const clientId = clampText(payload?.clientId, 80) || meta0?.clientId || ("c_" + uid(8));
    const ban = isBanned(clientId, ip);
    if (!ban.ok) {
      status(socket, "error", "⛔ Siz vaqtincha BAN bo‘lgansiz.");
      socket.disconnect(true);
      return;
    }

    const name = clampText(payload?.name, NAME_MAX_LEN) || "NoName";
    const level = String(payload?.level || "").toUpperCase();
    const gender = String(payload?.gender || "").toLowerCase();

    if (!isValidLevel(level)) return status(socket, "error", "Level noto‘g‘ri (A1–C2).");
    if (!isValidGender(gender)) return status(socket, "error", "Gender noto‘g‘ri (male/female).");

    const metaNow = socketMeta.get(socket.id) || {};
    if (metaNow.roomId) return status(socket, "error", "Siz allaqachon chatdasiz.");

    if (metaNow.lastJoinAt && now() - metaNow.lastJoinAt < JOIN_COOLDOWN_MS) {
      return status(socket, "error", "Juda tez bosyapsiz. 1 soniya kuting 🙂");
    }
    metaNow.lastJoinAt = now();

    removeFromWaitingSocket(socket.id);
    removeFromWaitingClient(clientId);

    const key = keyOf(level, gender);
    const q = ensureQueue(key);

    socketMeta.set(socket.id, { ...metaNow, clientId, name, level, gender, key, roomId: null, ip });

    let other = q.shift();
    while (other && !io.sockets.sockets.get(other.socketId)) other = q.shift();

    if (!other) {
      q.push({ socketId: socket.id, clientId, name, level, gender, joinedAt: now() });
      status(socket, "waiting", `⏳ Kutilyapti… (${level}, ${gender})`, { key });
      emitGlobalStats();
      return;
    }

    const otherSock = io.sockets.sockets.get(other.socketId);
    if (!otherSock) {
      q.push({ socketId: socket.id, clientId, name, level, gender, joinedAt: now() });
      status(socket, "waiting", `⏳ Kutilyapti… (${level}, ${gender})`, { key });
      emitGlobalStats();
      return;
    }

    const roomId = createRoomId();
    const iceQuestions = pick3Questions();

    rooms.set(roomId, {
      a: other.socketId,
      b: socket.id,
      key,
      createdAt: now(),
      lastActiveAt: now(),
      history: [],
      lock: true,
      ice: { questions: iceQuestions, index: 0 }
    });

    otherSock.join(roomId);
    socket.join(roomId);

    const om = socketMeta.get(other.socketId);
    if (om) socketMeta.set(other.socketId, { ...om, roomId, key });
    socketMeta.set(socket.id, { ...socketMeta.get(socket.id), roomId, key });

    metrics.matches++;

    socket.emit("matched", {
      ts: now(),
      roomId,
      you: { name, level, gender },
      partner: { name: other.name, level: other.level, gender: other.gender }
    });

    otherSock.emit("matched", {
      ts: now(),
      roomId,
      you: { name: other.name, level: other.level, gender: other.gender },
      partner: { name, level, gender }
    });

    io.to(roomId).emit("status", { ts: now(), type: "matched", message: "✅ Match topildi. Chat faqat 2 kishilik." });

    emitIcebreaker(roomId);
    emitGlobalStats();
  });

  socket.on("get_history", () => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    const r = rooms.get(m.roomId);
    socket.emit("history", { ts: now(), roomId: m.roomId, items: r?.history || [] });
  });

  socket.on("ice_next", () => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;
    iceNav(m.roomId, "next");
  });

  socket.on("ice_prev", () => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;
    iceNav(m.roomId, "prev");
  });

  // typing
  let lastTypingAt = 0;
  socket.on("typing", (payload) => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;

    const t = now();
    if (t - lastTypingAt < TYPING_THROTTLE_MS) return;
    lastTypingAt = t;

    socket.to(m.roomId).emit("typing", { ts: t, from: m.name || "Partner", on: !!payload?.on });
  });

  // message
  socket.on("send_message", (payload) => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return status(socket, "error", "Avval partner toping.");
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return status(socket, "error", "Room 1v1 holatda emas.");

    const verdict = canSendMessage(socket.id);
    if (!verdict.ok) {
      if (verdict.reason === "muted") return status(socket, "error", `Siz ${verdict.seconds}s mute bo‘lgansiz.`);
      if (verdict.reason === "rate") return status(socket, "error", "Juda tez yozayapsiz. Sekinroq 🙂");
      return status(socket, "error", "Xabar yuborilmadi.");
    }

    const text = safeMsg(payload?.text);
    if (!text.trim()) return;

    const msg = { id: "m_" + uid(6), from: m.name || "User", fromClientId: m.clientId, text, at: now() };
    metrics.messages++;
    pushHistory(m.roomId, msg);
    io.to(m.roomId).emit("message", msg);
  });

  socket.on("read_up_to", (payload) => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;
    const msgId = String(payload?.msgId || "");
    if (!msgId) return;
    socket.to(m.roomId).emit("read_up_to", { ts: now(), reader: m.name || "Partner", msgId });
  });

  socket.on("report_partner", () => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    const otherId = otherSocket(m.roomId, socket.id);
    if (!otherId) return;
    const om = socketMeta.get(otherId);
    if (!om) return;

    om.reports = (om.reports || 0) + 1;
    metrics.reports++;
    status(socket, "info", "✅ Report qabul qilindi.");

    if (om.reports >= REPORT_TO_MUTE) {
      om.mutedUntil = now() + AUTO_MUTE_MS;
      metrics.mutes++;
      const otherSock = io.sockets.sockets.get(otherId);
      if (otherSock) status(otherSock, "error", "Siz ko‘p report oldingiz. 5 daqiqa mute.");
    }
  });

  socket.on("leave_chat", () => {
    removeFromWaitingSocket(socket.id);

    const m = socketMeta.get(socket.id);
    if (!m?.roomId) {
      status(socket, "info", "Siz chatda emassiz.");
      emitGlobalStats();
      return;
    }

    const roomId = m.roomId;
    const otherId = otherSocket(roomId, socket.id);

    socket.leave(roomId);
    socketMeta.set(socket.id, { ...m, roomId: null });
    socket.emit("left", { ts: now(), roomId });

    if (otherId) {
      const otherSock = io.sockets.sockets.get(otherId);
      const om = socketMeta.get(otherId);
      if (otherSock) {
        otherSock.emit("partner_left", { ts: now(), roomId });
        otherSock.leave(roomId);
      }
      if (om) socketMeta.set(otherId, { ...om, roomId: null });
    }

    destroyRoom(roomId, "user_left");
    emitGlobalStats();
  });

  // voice relay
  function voiceRelay(eventName, data) {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;
    socket.to(m.roomId).emit(eventName, { ts: now(), ...data });
  }

  socket.on("voice_offer", (offer) => { metrics.voiceOffers++; voiceRelay("voice_offer", { offer }); });
  socket.on("voice_answer", (answer) => { metrics.voiceAnswers++; voiceRelay("voice_answer", { answer }); });
  socket.on("voice_ice", (candidate) => { metrics.voiceIce++; voiceRelay("voice_ice", { candidate }); });

  // admin socket
  socket.on("admin_auth", (payload) => {
    const token = String(payload?.token || "");
    if (token !== ADMIN_TOKEN) {
      socket.emit("admin_auth_result", { ok: false });
      return;
    }
    socket.join("ADMIN_ROOM");
    socket.emit("admin_auth_result", { ok: true });
    socket.emit("admin_snapshot", buildAdminSnapshot());
  });

  function buildAdminSnapshot() {
    const sockets = Array.from(socketMeta.entries()).map(([sid, m]) => ({
      socketId: sid,
      clientId: m.clientId,
      name: m.name,
      level: m.level,
      gender: m.gender,
      roomId: m.roomId,
      reports: m.reports || 0,
      mutedUntil: m.mutedUntil || 0,
      ip: m.ip
    }));

    const roomDump = Array.from(rooms.entries()).map(([rid, r]) => ({
      roomId: rid,
      key: r.key,
      a: r.a,
      b: r.b,
      size: roomSize(rid),
      createdAt: r.createdAt,
      lastActiveAt: r.lastActiveAt,
      lock: r.lock,
      iceIndex: r.ice?.index ?? null,
      ice: r.ice?.questions ?? null,
      historyLen: r.history?.length || 0
    }));

    return {
      ts: now(),
      onlineUsers,
      rooms: rooms.size,
      queue: queueStats(),
      metrics,
      sockets,
      roomDump,
      bannedClients: Array.from(bannedClients.entries()),
      bannedIps: Array.from(bannedIps.entries()),
      logs
    };
  }

  function adminBroadcast() {
    io.to("ADMIN_ROOM").emit("admin_snapshot", buildAdminSnapshot());
  }

  socket.on("admin_action", (payload) => {
    const token = String(payload?.token || "");
    if (token !== ADMIN_TOKEN) return;

    const action = String(payload?.action || "");
    const targetSocketId = String(payload?.targetSocketId || "");
    const minutes = Number(payload?.minutes || 5);
    const banIp = String(payload?.ip || "");
    const durMs = Math.max(1, minutes) * 60 * 1000;

    const targetSock = io.sockets.sockets.get(targetSocketId);
    const tm = socketMeta.get(targetSocketId);

    if (action === "kick") {
      if (targetSock) { status(targetSock, "error", "Admin sizni chiqardi."); targetSock.disconnect(true); }
      adminBroadcast(); return;
    }
    if (action === "mute") {
      if (tm) { tm.mutedUntil = now() + durMs; metrics.mutes++; if (targetSock) status(targetSock, "error", `Admin sizni ${minutes} min mute qildi.`); }
      adminBroadcast(); return;
    }
    if (action === "ban_client") {
      if (tm) {
        bannedClients.set(tm.clientId, now() + durMs);
        metrics.bans++;
        if (targetSock) { status(targetSock, "error", `Siz ${minutes} min BAN bo‘ldingiz.`); targetSock.disconnect(true); }
      }
      adminBroadcast(); return;
    }
    if (action === "ban_ip") {
      if (banIp) { bannedIps.set(banIp, now() + durMs); metrics.bans++; }
      adminBroadcast(); return;
    }
  });

  socket.on("disconnect", () => {
    metrics.disconnections++;
    onlineUsers = Math.max(0, onlineUsers - 1);

    removeFromWaitingSocket(socket.id);

    const m = socketMeta.get(socket.id);
    if (m?.roomId) {
      const roomId = m.roomId;
      const otherId = otherSocket(roomId, socket.id);

      if (otherId) {
        const otherSock = io.sockets.sockets.get(otherId);
        const om = socketMeta.get(otherId);
        if (otherSock) {
          otherSock.emit("partner_left", { ts: now(), roomId });
          otherSock.leave(roomId);
        }
        if (om) socketMeta.set(otherId, { ...om, roomId: null });
      }

      destroyRoom(roomId, "disconnect");
    }

    if (m?.clientId && clientIndex.get(m.clientId) === socket.id) clientIndex.delete(m.clientId);
    socketMeta.delete(socket.id);

    emitGlobalStats();
    adminBroadcast();
  });
});

// ---------------- START ----------------
server.listen(PORT, () => {
  console.log(`✅ App running: http://localhost:${PORT}`);
  console.log(`🛡 Admin token set? ${ADMIN_TOKEN !== "CHANGE_ME_ADMIN_TOKEN" ? "YES" : "NO (set ADMIN_TOKEN env)"}`);
});
