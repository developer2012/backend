// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

const users = new Map();
const waitingByLevel = { A1: [], A2: [], B1: [], B2: [], C1: [], C2: [] };
const rooms = new Map();

const LEVELS = new Set(["A1","A2","B1","B2","C1","C2"]);
const GENDERS = new Set(["any","male","female"]);

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
function safeStr(s, max = 24) {
  if (!s) return "";
  s = String(s).trim();
  if (s.length > max) s = s.slice(0, max);
  return s.replace(/[^\p{L}\p{N}\s._-]/gu, "");
}
function logOnline() {
  const list = [];
  for (const [id, u] of users.entries()) list.push(`${u.name}(${u.level}/${u.gender})`);
  console.log(`[${now()}] ONLINE(${users.size}): ${list.join(", ") || "-"}`);
}
function logQueues() {
  const q = Object.entries(waitingByLevel).map(([lvl, arr]) => `${lvl}:${arr.length}`).join("  ");
  console.log(`[${now()}] QUEUES: ${q}`);
}
function logRooms() {
  console.log(`[${now()}] ROOMS(${rooms.size})`);
  for (const [rid, r] of rooms.entries()) {
    const a = users.get(r.a)?.name || r.a;
    const b = users.get(r.b)?.name || r.b;
    console.log(`  - ${rid}: ${a} <-> ${b}`);
  }
}
function removeFromAllQueues(socketId) {
  for (const lvl of Object.keys(waitingByLevel)) {
    const arr = waitingByLevel[lvl];
    const idx = arr.indexOf(socketId);
    if (idx !== -1) arr.splice(idx, 1);
  }
}
function isGenderCompatible(meGender, otherGender) {
  if (meGender === "any" || otherGender === "any") return true;
  return meGender === otherGender;
}
function makeRoomId(a, b) {
  const x = [a, b].sort().join("-");
  return `room_${x.slice(0, 10)}_${Date.now().toString(36)}`;
}
function endRoom(roomId, reason = "ended") {
  const r = rooms.get(roomId);
  if (!r) return;

  const aSock = io.sockets.sockets.get(r.a);
  const bSock = io.sockets.sockets.get(r.b);

  if (aSock) aSock.leave(roomId);
  if (bSock) bSock.leave(roomId);

  const ua = users.get(r.a);
  const ub = users.get(r.b);
  if (ua) ua.room = null;
  if (ub) ub.room = null;

  rooms.delete(roomId);
  io.to(roomId).emit("roomEnded", { reason });

  console.log(`[${now()}] ROOM END: ${roomId} (${reason})`);
  logRooms();
}
function sendOnlineCount() {
  io.emit("onlineCount", { count: users.size });
}

io.on("connection", (socket) => {
  console.log(`[${now()}] CONNECT: ${socket.id}`);

  socket.on("hello", (payload = {}) => {
    let name = safeStr(payload.name, 20) || "Guest";
    let level = String(payload.level || "").toUpperCase();
    let gender = String(payload.gender || "").toLowerCase();

    if (!LEVELS.has(level)) level = "B1";
    if (!GENDERS.has(gender)) gender = "any";

    users.set(socket.id, { name, level, gender, joinedAt: Date.now(), room: null });

    console.log(`[${now()}] HELLO: ${socket.id} -> ${name} (${level}/${gender})`);
    sendOnlineCount();
    logOnline();
    logQueues();

    socket.emit("helloOk", { id: socket.id, name, level, gender });
  });

  socket.on("joinQueue", () => {
    const me = users.get(socket.id);
    if (!me) return socket.emit("errorMsg", { msg: "Avval formni to‘ldirib kir." });
    if (me.room) return socket.emit("errorMsg", { msg: "Siz allaqachon chatdasiz." });

    removeFromAllQueues(socket.id);

    const lvl = me.level;
    const q = waitingByLevel[lvl];

    let matchId = null;
    for (const otherId of q) {
      const other = users.get(otherId);
      if (!other) continue;
      if (other.room) continue;
      if (isGenderCompatible(me.gender, other.gender)) { matchId = otherId; break; }
    }

    if (matchId) {
      const idx = q.indexOf(matchId);
      if (idx !== -1) q.splice(idx, 1);

      const roomId = makeRoomId(socket.id, matchId);
      rooms.set(roomId, { a: socket.id, b: matchId, createdAt: Date.now() });

      const otherSock = io.sockets.sockets.get(matchId);
      if (!otherSock) {
        rooms.delete(roomId);
        return socket.emit("waiting", { msg: "Match topildi, lekin u chiqib ketdi. Qayta urinib ko‘r." });
      }

      socket.join(roomId);
      otherSock.join(roomId);

      me.room = roomId;
      const other = users.get(matchId);
      if (other) other.room = roomId;

      console.log(`[${now()}] MATCH: ${me.name} <-> ${other?.name || matchId} | ${roomId}`);
      logQueues();
      logRooms();

      io.to(roomId).emit("matched", {
        roomId,
        a: { id: socket.id, name: me.name, level: me.level, gender: me.gender },
        b: { id: matchId, name: other?.name || "Guest", level: other?.level || me.level, gender: other?.gender || "any" },
      });
    } else {
      q.push(socket.id);
      console.log(`[${now()}] QUEUED: ${me.name} (${me.level}/${me.gender})`);
      logQueues();
      socket.emit("waiting", { msg: "Partner kutilyapti..." });
    }
  });

  socket.on("leaveRoom", () => {
    const me = users.get(socket.id);
    if (!me?.room) return;
    endRoom(me.room, "left");
  });

  socket.on("next", () => {
    const me = users.get(socket.id);
    if (!me) return;
    if (me.room) endRoom(me.room, "next");
    socket.emit("infoMsg", { msg: "Yangi odam qidirilyapti..." });
    socket.emit("autoJoinQueue");
  });

  socket.on("chat", (data = {}) => {
    const me = users.get(socket.id);
    if (!me?.room) return;
    const text = safeStr(data.text, 400);
    if (!text) return;

    io.to(me.room).emit("chat", { from: socket.id, name: me.name, text, at: Date.now() });
  });

  // ✅ WebRTC signaling relay (voice uchun)
  socket.on("signal", (data = {}) => {
    const me = users.get(socket.id);
    if (!me?.room) return;
    socket.to(me.room).emit("signal", { ...data, from: socket.id });
  });

  socket.on("voiceState", (data = {}) => {
    const me = users.get(socket.id);
    if (!me?.room) return;
    console.log(`[${now()}] VOICE: ${users.get(socket.id)?.name || socket.id} -> ${data?.state || "?"}`);
    socket.to(me.room).emit("voiceState", { from: socket.id, state: data?.state || "unknown" });
  });

  socket.on("disconnect", () => {
    const me = users.get(socket.id);
    console.log(`[${now()}] DISCONNECT: ${socket.id} (${me?.name || "?"})`);

    if (me?.room) endRoom(me.room, "disconnect");
    removeFromAllQueues(socket.id);
    users.delete(socket.id);

    sendOnlineCount();
    logOnline();
    logQueues();
  });
});

server.listen(3000, () => {
  console.log(`[${now()}] Server running on http://localhost:3000`);
});
