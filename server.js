// ==========================================================
// MatchTalk — Voice + Text Match Chat (Node + Socket.IO)
// ✅ Level + Gender matching
// ✅ Online users / rooms / queues logs in terminal
// ✅ Realtime text chat
// ✅ WebRTC signaling relay for voice
// ==========================================================

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// serve frontend
app.use(express.static(path.join(__dirname, "public")));

// ====== STATE ======
const USERS = new Map(); // socketId -> {name, level, gender, room, joinedAt}
const ROOMS = new Map(); // roomId -> {a, b, createdAt}
const QUEUES = {
  A1: [], A2: [], B1: [], B2: [], C1: [], C2: []
};

const LEVELS = new Set(["A1","A2","B1","B2","C1","C2"]);
const GENDERS = new Set(["any","male","female"]);

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function safeStr(s, max = 24) {
  if (!s) return "";
  s = String(s).trim();
  if (s.length > max) s = s.slice(0, max);
  // remove weird characters
  return s.replace(/[^\p{L}\p{N}\s._-]/gu, "");
}

function removeFromQueues(id) {
  for (const lvl of Object.keys(QUEUES)) {
    const q = QUEUES[lvl];
    const i = q.indexOf(id);
    if (i !== -1) q.splice(i, 1);
  }
}

function genderCompatible(g1, g2) {
  // "any" means no preference
  if (g1 === "any" || g2 === "any") return true;
  return g1 === g2;
}

function makeRoomId(a, b) {
  const x = [a, b].sort().join("-");
  return `room_${x.slice(0, 10)}_${Date.now().toString(36)}`;
}

// terminal logs
function logOnline() {
  const list = [];
  for (const [id, u] of USERS.entries()) {
    list.push(`${u.name}(${u.level}/${u.gender})`);
  }
  console.log(`[${ts()}] ONLINE(${USERS.size}): ${list.join(", ") || "-"}`);
}

function logQueues() {
  const q = Object.entries(QUEUES).map(([lvl, arr]) => `${lvl}:${arr.length}`).join("  ");
  console.log(`[${ts()}] QUEUES: ${q}`);
}

function logRooms() {
  console.log(`[${ts()}] ROOMS(${ROOMS.size})`);
  for (const [rid, r] of ROOMS.entries()) {
    const a = USERS.get(r.a)?.name || r.a;
    const b = USERS.get(r.b)?.name || r.b;
    console.log(`  - ${rid}: ${a} <-> ${b}`);
  }
}

function broadcastOnlineCount() {
  io.emit("onlineCount", { count: USERS.size });
}

function endRoom(roomId, reason = "ended") {
  const r = ROOMS.get(roomId);
  if (!r) return;

  const aSock = io.sockets.sockets.get(r.a);
  const bSock = io.sockets.sockets.get(r.b);

  if (aSock) aSock.leave(roomId);
  if (bSock) bSock.leave(roomId);

  const ua = USERS.get(r.a);
  const ub = USERS.get(r.b);
  if (ua) ua.room = null;
  if (ub) ub.room = null;

  ROOMS.delete(roomId);

  // notify both
  io.to(roomId).emit("roomEnded", { reason });

  console.log(`[${ts()}] ROOM END: ${roomId} (${reason})`);
  logRooms();
}

io.on("connection", (socket) => {
  console.log(`[${ts()}] CONNECT: ${socket.id}`);

  socket.on("hello", (payload = {}) => {
    let name = safeStr(payload.name, 20) || "Guest";
    let level = String(payload.level || "").toUpperCase();
    let gender = String(payload.gender || "").toLowerCase();

    if (!LEVELS.has(level)) level = "B1";
    if (!GENDERS.has(gender)) gender = "any";

    USERS.set(socket.id, {
      name,
      level,
      gender,
      room: null,
      joinedAt: Date.now(),
    });

    console.log(`[${ts()}] HELLO: ${name} (${level}/${gender}) [${socket.id}]`);
    broadcastOnlineCount();
    logOnline();
    logQueues();

    socket.emit("helloOk", { id: socket.id, name, level, gender });
  });

  socket.on("joinQueue", () => {
    const me = USERS.get(socket.id);
    if (!me) return socket.emit("errorMsg", { msg: "Avval ism/level/gender tanlab Start bosing." });
    if (me.room) return socket.emit("errorMsg", { msg: "Siz allaqachon chatdasiz." });

    // clear old queue entry
    removeFromQueues(socket.id);

    const q = QUEUES[me.level];
    let matchId = null;

    // find a compatible partner
    for (const otherId of q) {
      const other = USERS.get(otherId);
      if (!other) continue;
      if (other.room) continue;
      if (genderCompatible(me.gender, other.gender)) {
        matchId = otherId;
        break;
      }
    }

    if (!matchId) {
      q.push(socket.id);
      console.log(`[${ts()}] QUEUED: ${me.name} (${me.level}/${me.gender})`);
      logQueues();
      return socket.emit("waiting", { msg: "Partner kutilyapti..." });
    }

    // remove matched partner from queue
    const idx = q.indexOf(matchId);
    if (idx !== -1) q.splice(idx, 1);

    // create room
    const roomId = makeRoomId(socket.id, matchId);
    ROOMS.set(roomId, { a: socket.id, b: matchId, createdAt: Date.now() });

    const otherSock = io.sockets.sockets.get(matchId);
    if (!otherSock) {
      ROOMS.delete(roomId);
      return socket.emit("waiting", { msg: "Partner chiqib ketdi. Yana urinib ko‘ring." });
    }

    // join both
    socket.join(roomId);
    otherSock.join(roomId);

    me.room = roomId;
    const other = USERS.get(matchId);
    if (other) other.room = roomId;

    console.log(`[${ts()}] MATCH: ${me.name} <-> ${other?.name || matchId} | ${roomId}`);
    logQueues();
    logRooms();

    io.to(roomId).emit("matched", {
      roomId,
      a: { id: socket.id, name: me.name, level: me.level, gender: me.gender },
      b: { id: matchId, name: other?.name || "Guest", level: other?.level || me.level, gender: other?.gender || "any" },
    });
  });

  socket.on("chat", (data = {}) => {
    const me = USERS.get(socket.id);
    if (!me?.room) return;

    const text = safeStr(data.text, 500);
    if (!text) return;

    io.to(me.room).emit("chat", {
      from: socket.id,
      name: me.name,
      text,
      at: Date.now(),
    });
  });

  socket.on("leaveRoom", () => {
    const me = USERS.get(socket.id);
    if (!me?.room) return;
    endRoom(me.room, "left");
  });

  socket.on("next", () => {
    const me = USERS.get(socket.id);
    if (!me) return;

    if (me.room) endRoom(me.room, "next");
    socket.emit("infoMsg", { msg: "Yangi odam qidirilyapti..." });
    socket.emit("autoJoinQueue");
  });

  // ✅ WebRTC SIGNAL RELAY (voice)
  socket.on("signal", (data = {}) => {
    const me = USERS.get(socket.id);
    if (!me?.room) return;
    // send only to partner in same room
    socket.to(me.room).emit("signal", { ...data, from: socket.id });
  });

  socket.on("voiceState", (data = {}) => {
    const me = USERS.get(socket.id);
    if (!me?.room) return;

    const state = safeStr(data.state, 30) || "unknown";
    console.log(`[${ts()}] VOICE: ${me.name} -> ${state}`);
    socket.to(me.room).emit("voiceState", { from: socket.id, state });
  });

  socket.on("disconnect", () => {
    const me = USERS.get(socket.id);
    console.log(`[${ts()}] DISCONNECT: ${socket.id} (${me?.name || "?"})`);

    // end room if needed
    if (me?.room) endRoom(me.room, "disconnect");

    removeFromQueues(socket.id);
    USERS.delete(socket.id);

    broadcastOnlineCount();
    logOnline();
    logQueues();
  });
});

server.listen(3000, () => {
  console.log(`[${ts()}] Server running on http://localhost:3000`);
});
