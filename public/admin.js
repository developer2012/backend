// public/admin.js
const socket = io();

const el = (id) => document.getElementById(id);
const tokenIn = el("token");
const loginBtn = el("loginBtn");
const adminStatus = el("adminStatus");

const statsLine = el("statsLine");
const statsJson = el("statsJson");

const sockTable = el("sockTable");
const targetSocketId = el("targetSocketId");
const minutesIn = el("minutes");

const kickBtn = el("kickBtn");
const muteBtn = el("muteBtn");
const banBtn = el("banBtn");

let token = "";

function setAdminStatus(t, type="info"){
  adminStatus.textContent = t;
  adminStatus.style.color =
    type === "error" ? "rgba(239,68,68,.95)" :
    type === "ok" ? "rgba(34,197,94,.95)" :
    "rgba(255,255,255,.70)";
}

loginBtn.addEventListener("click", () => {
  token = tokenIn.value.trim();
  if (!token) return setAdminStatus("Token kiriting.", "error");
  socket.emit("admin_auth", { token });
  setAdminStatus("Auth yuborildi…", "info");
});

socket.on("admin_auth_result", (r) => {
  if (r.ok) setAdminStatus("✅ Admin ulandi!", "ok");
  else setAdminStatus("❌ Token noto‘g‘ri", "error");
});

socket.on("admin_snapshot", (snap) => {
  statsLine.textContent = `Online: ${snap.onlineUsers} | Rooms: ${snap.rooms} | TS: ${new Date(snap.ts).toLocaleTimeString()}`;
  statsJson.textContent = JSON.stringify({
    onlineUsers: snap.onlineUsers,
    rooms: snap.rooms,
    queue: snap.queue,
    bannedClients: snap.bannedClients,
    bannedIps: snap.bannedIps
  }, null, 2);

  renderSockets(snap.sockets || []);
});

function renderSockets(list){
  sockTable.innerHTML = "";
  for (const s of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="btn ghost" style="padding:6px 10px" data-sid="${s.socketId}">Pick</button> ${s.socketId.slice(0,10)}…</td>
      <td>${s.name || "-"}</td>
      <td>${s.level || "-"}</td>
      <td>${s.gender || "-"}</td>
      <td>${s.roomId ? s.roomId.slice(0,10)+"…" : "-"}</td>
      <td>${s.reports || 0}</td>
    `;
    tr.querySelector("button").addEventListener("click", (e) => {
      targetSocketId.value = e.target.dataset.sid;
    });
    sockTable.appendChild(tr);
  }
}

function doAction(action){
  if (!token) return setAdminStatus("Avval login qiling.", "error");
  const sid = targetSocketId.value.trim();
  const minutes = Number(minutesIn.value || 5);
  if (!sid) return setAdminStatus("target socketId kiriting.", "error");

  socket.emit("admin_action", { token, action, targetSocketId: sid, minutes });
  setAdminStatus(`Action yuborildi: ${action}`, "info");
}

kickBtn.addEventListener("click", () => doAction("kick"));
muteBtn.addEventListener("click", () => doAction("mute"));
banBtn.addEventListener("click", () => doAction("ban_client"));
