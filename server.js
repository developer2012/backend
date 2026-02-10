// server.js
// =====================================================================================
// SAYRA FULL — 1v1 MATCH + TEXT CHAT + VOICE (WebRTC signaling) + ADMIN PANEL
// =====================================================================================
// ✅ Level + gender based matchmaking (A1..C2, male/female)
// ✅ Strict 1v1: max 2 users per room (no 3rd user)
// ✅ Socket.IO text chat, typing, history, spam-limit
// ✅ WebRTC voice signaling: offer/answer/ice in room
// ✅ Reconnect (clientId), online stats, queue stats
// ✅ Moderation: report -> auto mute, admin mute/ban/kick
// ✅ Admin web panel endpoints + socket channel (token protected)
// NOTE: This is in-memory demo; for production add DB.
// =====================================================================================

"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// ------------------- CONFIG -------------------
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "1029384756";

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const GENDERS = ["male", "female"];
const MAX_ROOM_USERS = 2;

// message controls
const MSG_MAX_LEN = 800;
const MSG_RATE_WINDOW_MS = 5000;
const MSG_RATE_MAX = 8;

// report/mute
const REPORT_LIMIT_BEFORE_MUTE = 3;
const AUTO_MUTE_MS = 5 * 60 * 1000;

// ban
const BAN_DEFAULT_MS = 30 * 60 * 1000;

// history
const ROOM_HISTORY_LIMIT = 60;

// ------------------- APP -------------------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { transports: ["websocket", "polling"] });

// ------------------- STATE -------------------
// waiting queues by key => [{socketId, clientId, name, level, gender, joinedAt}]
const waiting = new Map();

// rooms => roomId => { a, b, key, createdAt, history: [] }
const rooms = new Map();

// socketMeta => socketId => { clientId, name, level, gender, key, roomId, msgTimes, reports, mutedUntil }
const socketMeta = new Map();

// clientIndex => clientId => socketId (for reconnect)
const clientIndex = new Map();

// moderation
const bannedClients = new Map(); // clientId -> bannedUntil
const bannedIps = new Map();     // ip -> bannedUntil (best-effort)
let onlineUsers = 0;

// ------------------- HELPERS -------------------
const now = () => Date.now();
const uid = (n = 10) => crypto.randomBytes(n).toString("hex");

function safeText(x, max = 32) {
  return String(x ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}
function safeMsg(x) {
  return String(x ?? "").replace(/\r/g, "").slice(0, MSG_MAX_LEN);
}
function isValidLevel(x) {
  return LEVELS.includes(String(x).toUpperCase());
}
function isValidGender(x) {
  return GENDERS.includes(String(x).toLowerCase());
}
function keyOf(level, gender) {
  return `${String(level).toUpperCase()}__${String(gender).toLowerCase()}`;
}
function createRoomId() {
  return `room_${uid(6)}_${now().toString(16)}`;
}

function roomSize(roomId) {
  const r = rooms.get(roomId);
  if (!r) return 0;
  let c = 0;
  if (r.a) c++;
  if (r.b) c++;
  return c;
}
function otherInRoom(roomId, mySocketId) {
  const r = rooms.get(roomId);
  if (!r) return null;
  if (r.a === mySocketId) return r.b || null;
  if (r.b === mySocketId) return r.a || null;
  return null;
}

function ensureQueue(key) {
  if (!waiting.has(key)) waiting.set(key, []);
  return waiting.get(key);
}
function removeFromWaitingSocket(socketId) {
  for (const [k, q] of waiting.entries()) {
    const i = q.findIndex(x => x.socketId === socketId);
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
    const i = q.findIndex(x => x.clientId === clientId);
    if (i !== -1) {
      q.splice(i, 1);
      if (!q.length) waiting.delete(k);
      return true;
    }
  }
  return false;
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
    onlineUsers,
    queue: queueStats(),
    rooms: rooms.size,
    ts: now()
  });
}

// anti-spam
function canSend(socketId) {
  const m = socketMeta.get(socketId);
  if (!m) return { ok:false, reason:"no_meta" };

  if (m.mutedUntil && now() < m.mutedUntil) {
    return { ok:false, reason:"muted", seconds: Math.ceil((m.mutedUntil - now())/1000) };
  }

  const t = now();
  const arr = m.msgTimes || [];
  const keep = arr.filter(x => (t - x) <= MSG_RATE_WINDOW_MS);
  keep.push(t);
  m.msgTimes = keep;

  if (keep.length > MSG_RATE_MAX) return { ok:false, reason:"rate" };
  return { ok:true };
}

function isBanned(clientId, ip) {
  const t = now();
  const bc = bannedClients.get(clientId);
  if (bc && t < bc) return { ok:false, reason:"client", until:bc };
  const bi = bannedIps.get(ip);
  if (bi && t < bi) return { ok:false, reason:"ip", until:bi };
  return { ok:true };
}

function destroyRoom(roomId, reason="closed") {
  if (!rooms.has(roomId)) return;
  io.to(roomId).emit("room_closed", { roomId, reason });
  rooms.delete(roomId);
}

// ------------------- ADMIN HTTP -------------------
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok:false, error:"unauthorized" });
  }
  next();
}

app.get("/admin/api/stats", requireAdmin, (req, res) => {
  const sockets = Array.from(socketMeta.entries()).map(([sid, m]) => ({
    socketId: sid,
    clientId: m.clientId,
    name: m.name,
    level: m.level,
    gender: m.gender,
    roomId: m.roomId,
    reports: m.reports || 0,
    mutedUntil: m.mutedUntil || null
  }));

  res.json({
    ok:true,
    ts: now(),
    onlineUsers,
    rooms: rooms.size,
    queue: queueStats(),
    sockets,
    bannedClients: Array.from(bannedClients.entries()),
    bannedIps: Array.from(bannedIps.entries())
  });
});

// ------------------- SOCKET.IO -------------------
io.on("connection", (socket) => {
  onlineUsers++;
  emitGlobalStats();

  const ip = socket.handshake.address || "unknown";

  socket.emit("status", { type:"connected", message:"✅ Ulandingiz." });

  // HELLO handshake (clientId for reconnect)
  socket.on("hello", (payload) => {
    const clientId = safeText(payload?.clientId, 80) || ("c_" + uid(8));

    // ban check
    const ban = isBanned(clientId, ip);
    if (!ban.ok) {
      socket.emit("status", { type:"error", message:"⛔ Siz vaqtincha BAN bo‘lgansiz." });
      socket.disconnect(true);
      return;
    }

    // if same clientId already connected, disconnect old one
    const prevSocketId = clientIndex.get(clientId);
    if (prevSocketId && prevSocketId !== socket.id) {
      const prev = io.sockets.sockets.get(prevSocketId);
      try { prev?.disconnect(true); } catch {}
    }

    clientIndex.set(clientId, socket.id);

    // init meta if missing
    if (!socketMeta.has(socket.id)) {
      socketMeta.set(socket.id, {
        clientId,
        name: null,
        level: null,
        gender: null,
        key: null,
        roomId: null,
        msgTimes: [],
        reports: 0,
        mutedUntil: 0
      });
    } else {
      socketMeta.get(socket.id).clientId = clientId;
    }

    socket.emit("hello_ok", { clientId });
  });

  // FIND PARTNER
  socket.on("find_partner", (payload) => {
    const m0 = socketMeta.get(socket.id);
    const clientId = safeText(payload?.clientId, 80) || m0?.clientId || ("c_" + uid(8));

    // ban check again (if admin banned after connect)
    const ban = isBanned(clientId, ip);
    if (!ban.ok) {
      socket.emit("status", { type:"error", message:"⛔ Siz vaqtincha BAN bo‘lgansiz." });
      socket.disconnect(true);
      return;
    }

    const name = safeText(payload?.name, 24) || "NoName";
    const level = String(payload?.level || "").toUpperCase();
    const gender = String(payload?.gender || "").toLowerCase();

    if (!isValidLevel(level)) {
      socket.emit("status", { type:"error", message:"Level noto‘g‘ri (A1–C2)." });
      return;
    }
    if (!isValidGender(gender)) {
      socket.emit("status", { type:"error", message:"Gender noto‘g‘ri (male/female)." });
      return;
    }

    const metaNow = socketMeta.get(socket.id) || {};
    if (metaNow.roomId) {
      socket.emit("status", { type:"error", message:"Siz allaqachon chatdasiz." });
      return;
    }

    // remove old queue entries
    removeFromWaitingSocket(socket.id);
    removeFromWaitingClient(clientId);

    const key = keyOf(level, gender);
    const q = ensureQueue(key);

    // set meta
    socketMeta.set(socket.id, {
      ...metaNow,
      clientId, name, level, gender,
      key,
      roomId: null,
      msgTimes: metaNow.msgTimes || [],
      reports: metaNow.reports || 0,
      mutedUntil: metaNow.mutedUntil || 0
    });

    // try match
    let other = q.shift();
    while (other && !io.sockets.sockets.get(other.socketId)) other = q.shift();

    if (!other) {
      q.push({ socketId: socket.id, clientId, name, level, gender, joinedAt: now() });
      socket.emit("status", { type:"waiting", message:`⏳ Kutilyapti… (${level}, ${gender})` });
      emitGlobalStats();
      return;
    }

    const otherSock = io.sockets.sockets.get(other.socketId);
    if (!otherSock) {
      socket.emit("status", { type:"waiting", message:"Partner chiqib ketdi. Qayta qidiryapmiz…" });
      q.push({ socketId: socket.id, clientId, name, level, gender, joinedAt: now() });
      emitGlobalStats();
      return;
    }

    const roomId = createRoomId();
    rooms.set(roomId, { a: other.socketId, b: socket.id, key, createdAt: now(), history: [] });

    otherSock.join(roomId);
    socket.join(roomId);

    // update other meta
    const om = socketMeta.get(other.socketId);
    if (om) socketMeta.set(other.socketId, { ...om, roomId, key });

    socketMeta.set(socket.id, { ...socketMeta.get(socket.id), roomId, key });

    socket.emit("matched", {
      roomId,
      you: { name, level, gender },
      partner: { name: other.name, level: other.level, gender: other.gender }
    });

    otherSock.emit("matched", {
      roomId,
      you: { name: other.name, level: other.level, gender: other.gender },
      partner: { name, level, gender }
    });

    io.to(roomId).emit("status", { type:"matched", message:"✅ Match topildi. Chat faqat 2 kishilik." });

    emitGlobalStats();
  });

  // GET HISTORY
  socket.on("get_history", () => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    const r = rooms.get(m.roomId);
    socket.emit("history", { roomId: m.roomId, items: r?.history || [] });
  });

  // TYPING
  socket.on("typing", (payload) => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;
    socket.to(m.roomId).emit("typing", {
      from: m.name || "Partner",
      on: !!payload?.on,
      at: now()
    });
  });

  // SEND MESSAGE
  socket.on("send_message", (payload) => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) {
      socket.emit("status", { type:"error", message:"Avval partner toping." });
      return;
    }
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) {
      socket.emit("status", { type:"error", message:"Room 1v1 holatda emas." });
      return;
    }

    const verdict = canSend(socket.id);
    if (!verdict.ok) {
      if (verdict.reason === "muted") {
        socket.emit("status", { type:"error", message:`Siz ${verdict.seconds}s mute bo‘lgansiz.` });
      } else if (verdict.reason === "rate") {
        socket.emit("status", { type:"error", message:"Juda tez yozayapsiz. Sekinroq 🙂" });
      } else {
        socket.emit("status", { type:"error", message:"Xabar yuborilmadi." });
      }
      return;
    }

    const text = safeMsg(payload?.text);
    if (!text.trim()) return;

    const msg = { id: "m_" + uid(6), from: m.name || "User", text, at: now() };

    const r = rooms.get(m.roomId);
    if (r) {
      r.history.push(msg);
      if (r.history.length > ROOM_HISTORY_LIMIT) r.history.shift();
    }

    io.to(m.roomId).emit("message", msg);
  });

  // REPORT PARTNER
  socket.on("report_partner", () => {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;

    const otherId = otherInRoom(m.roomId, socket.id);
    if (!otherId) return;

    const om = socketMeta.get(otherId);
    if (!om) return;

    om.reports = (om.reports || 0) + 1;
    socket.emit("status", { type:"info", message:"✅ Report qabul qilindi." });

    if (om.reports >= REPORT_LIMIT_BEFORE_MUTE) {
      om.mutedUntil = now() + AUTO_MUTE_MS;
      const otherSock = io.sockets.sockets.get(otherId);
      otherSock?.emit("status", { type:"error", message:"Siz ko‘p report oldingiz. 5 daqiqa mute." });
    }
  });

  // LEAVE CHAT
  socket.on("leave_chat", () => {
    removeFromWaitingSocket(socket.id);

    const m = socketMeta.get(socket.id);
    if (!m?.roomId) {
      socket.emit("status", { type:"info", message:"Siz chatda emassiz." });
      emitGlobalStats();
      return;
    }

    const roomId = m.roomId;
    const otherId = otherInRoom(roomId, socket.id);

    socket.leave(roomId);
    socketMeta.set(socket.id, { ...m, roomId: null });

    socket.emit("left", { roomId });

    if (otherId) {
      const otherSock = io.sockets.sockets.get(otherId);
      const om = socketMeta.get(otherId);
      otherSock?.emit("partner_left", { roomId });
      otherSock?.leave(roomId);
      if (om) socketMeta.set(otherId, { ...om, roomId: null });
    }

    destroyRoom(roomId, "user_left");
    emitGlobalStats();
  });

  // ---------------- VOICE (WebRTC signaling) ----------------
  function voiceRelay(eventName, data) {
    const m = socketMeta.get(socket.id);
    if (!m?.roomId) return;
    if (roomSize(m.roomId) !== MAX_ROOM_USERS) return;
    socket.to(m.roomId).emit(eventName, data);
  }
  socket.on("voice_offer", (data) => voiceRelay("voice_offer", data));
  socket.on("voice_answer", (data) => voiceRelay("voice_answer", data));
  socket.on("voice_ice", (data) => voiceRelay("voice_ice", data));

  // ---------------- ADMIN SOCKET CHANNEL ----------------
  socket.on("admin_auth", (payload) => {
    const token = String(payload?.token || "");
    if (token !== ADMIN_TOKEN) {
      socket.emit("admin_auth_result", { ok:false });
      return;
    }
    socket.join("ADMIN_ROOM");
    socket.emit("admin_auth_result", { ok:true });
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
      mutedUntil: m.mutedUntil || 0
    }));
    return {
      ts: now(),
      onlineUsers,
      rooms: rooms.size,
      queue: queueStats(),
      sockets,
      bannedClients: Array.from(bannedClients.entries()),
      bannedIps: Array.from(bannedIps.entries())
    };
  }

  function emitAdminUpdate() {
    io.to("ADMIN_ROOM").emit("admin_snapshot", buildAdminSnapshot());
  }

  socket.on("admin_action", (payload) => {
    const token = String(payload?.token || "");
    if (token !== ADMIN_TOKEN) return;

    const action = String(payload?.action || "");
    const targetSocketId = String(payload?.targetSocketId || "");
    const minutes = Number(payload?.minutes || 5);

    const targetMeta = socketMeta.get(targetSocketId);
    const targetSock = io.sockets.sockets.get(targetSocketId);

    if (action === "kick" && targetSock) {
      targetSock.emit("status", { type:"error", message:"Admin sizni chiqardi." });
      targetSock.disconnect(true);
      emitAdminUpdate();
      return;
    }

    if (action === "mute" && targetMeta) {
      targetMeta.mutedUntil = now() + Math.max(1, minutes) * 60 * 1000;
      targetSock?.emit("status", { type:"error", message:`Admin sizni ${minutes} min mute qildi.` });
      emitAdminUpdate();
      return;
    }

    if (action === "ban_client" && targetMeta) {
      const until = now() + Math.max(1, minutes) * 60 * 1000;
      bannedClients.set(targetMeta.clientId, until);
      targetSock?.emit("status", { type:"error", message:`Siz ${minutes} min BAN bo‘ldingiz.` });
      targetSock?.disconnect(true);
      emitAdminUpdate();
      return;
    }

    if (action === "ban_ip") {
      const ipToBan = String(payload?.ip || "");
      if (ipToBan) {
        const until = now() + Math.max(1, minutes) * 60 * 1000;
        bannedIps.set(ipToBan, until);
        emitAdminUpdate();
      }
      return;
    }
  });

  // disconnect cleanup
  socket.on("disconnect", () => {
    onlineUsers = Math.max(0, onlineUsers - 1);

    removeFromWaitingSocket(socket.id);

    const m = socketMeta.get(socket.id);
    if (m?.roomId) {
      const roomId = m.roomId;
      const otherId = otherInRoom(roomId, socket.id);
      if (otherId) {
        const otherSock = io.sockets.sockets.get(otherId);
        const om = socketMeta.get(otherId);
        otherSock?.emit("partner_left", { roomId });
        otherSock?.leave(roomId);
        if (om) socketMeta.set(otherId, { ...om, roomId: null });
      }
      destroyRoom(roomId, "disconnect");
    }

    if (m?.clientId && clientIndex.get(m.clientId) === socket.id) clientIndex.delete(m.clientId);
    socketMeta.delete(socket.id);

    emitGlobalStats();
    io.to("ADMIN_ROOM").emit("admin_snapshot", buildAdminSnapshot());
  });
});

server.listen(PORT, () => {
  console.log(`✅ App:  http://localhost:${PORT}`);
  console.log(`✅ Admin: http://localhost:${PORT}/admin.html`);
  console.log(`⚠️ ADMIN_TOKEN env: ${ADMIN_TOKEN}`);
});
