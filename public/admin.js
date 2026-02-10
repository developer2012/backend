"use strict";

const $ = (id) => document.getElementById(id);
const socket = io();

let token = "";
let authed = false;
let pickedSocketId = "";

function setStatus(text, type="info"){
  const box = $("status");
  box.textContent = text;
  box.style.color =
    type==="error" ? "rgba(239,68,68,.95)" :
    type==="ok" ? "rgba(34,197,94,.95)" :
    "rgba(255,255,255,.75)";
}

function setAuth(on){
  authed = !!on;
  $("refreshBtn").disabled = !authed;
  $("kickBtn").disabled = !authed || !pickedSocketId;
  $("muteBtn").disabled = !authed || !pickedSocketId;
  $("banBtn").disabled  = !authed || !pickedSocketId;

  const b = $("authBadge");
  b.innerHTML = on ? 'Auth: <b>YES</b>' : 'Auth: <b>NO</b>';
  b.className = "badge " + (on ? "pillOk" : "pillBad");
}

function setPicked(id){
  pickedSocketId = id || "";
  $("picked").textContent = pickedSocketId || "—";
  $("kickBtn").disabled = !authed || !pickedSocketId;
  $("muteBtn").disabled = !authed || !pickedSocketId;
  $("banBtn").disabled  = !authed || !pickedSocketId;
}

$("loginBtn").addEventListener("click", ()=>{
  token = $("token").value.trim();
  if(!token) return setStatus("Token kiriting.", "error");
  socket.emit("admin_auth", { token });
  setStatus("Auth tekshirilmoqda…", "info");
});

$("refreshBtn").addEventListener("click", ()=>{
  if(!authed) return;
  socket.emit("admin_auth", { token }); // quick refresh snapshot
  setStatus("Refresh…", "info");
});

$("kickBtn").addEventListener("click", ()=>{
  if(!authed || !pickedSocketId) return;
  socket.emit("admin_action", { token, action:"kick", targetSocketId:pickedSocketId });
  setStatus("Kick yuborildi.", "ok");
});

$("muteBtn").addEventListener("click", ()=>{
  if(!authed || !pickedSocketId) return;
  const minutes = Number($("minutes").value || 5);
  socket.emit("admin_action", { token, action:"mute", targetSocketId:pickedSocketId, minutes });
  setStatus("Mute yuborildi.", "ok");
});

$("banBtn").addEventListener("click", ()=>{
  if(!authed || !pickedSocketId) return;
  const minutes = Number($("minutes").value || 5);
  socket.emit("admin_action", { token, action:"ban_client", targetSocketId:pickedSocketId, minutes });
  setStatus("Ban yuborildi.", "ok");
});

socket.on("admin_auth_result", (r)=>{
  if(r?.ok){
    setAuth(true);
    setStatus("✅ Admin kirdingiz.", "ok");
  } else {
    setAuth(false);
    setStatus("❌ Token noto‘g‘ri.", "error");
  }
});

function td(text, cls=""){
  const x = document.createElement("td");
  x.textContent = text ?? "";
  if(cls) x.className = cls;
  return x;
}

function buildSocketsTable(sockets){
  const body = $("sockBody");
  body.innerHTML = "";
  (sockets || []).forEach(s=>{
    const tr = document.createElement("tr");

    const pick = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Pick";
    btn.className = "btn ghost";
    btn.style.padding = "8px 12px";
    btn.style.borderRadius = "999px";
    btn.addEventListener("click", ()=> setPicked(s.socketId));
    pick.appendChild(btn);

    tr.appendChild(pick);
    tr.appendChild(td(s.name || "—"));
    tr.appendChild(td(`${s.level || "—"} / ${s.gender || "—"}`));
    tr.appendChild(td(s.roomId || "—", "mono"));
    tr.appendChild(td(String(s.reports || 0)));
    tr.appendChild(td(s.mutedUntil && Date.now() < s.mutedUntil ? "YES" : "NO"));
    tr.appendChild(td(s.socketId || "", "mono"));
    tr.appendChild(td(s.clientId || "", "mono"));

    body.appendChild(tr);
  });
}

function buildRoomsTable(rooms){
  const body = $("roomBody");
  body.innerHTML = "";
  (rooms || []).forEach(r=>{
    const tr = document.createElement("tr");
    tr.appendChild(td(r.roomId || "", "mono"));
    tr.appendChild(td(r.key || "—"));
    tr.appendChild(td(String(r.size || 0)));
    tr.appendChild(td((r.ice || []).join(" | ").slice(0, 80) || "—"));
    tr.appendChild(td(String(r.iceIndex ?? "—")));
    tr.appendChild(td(String(r.historyLen || 0)));
    body.appendChild(tr);
  });
}

socket.on("admin_snapshot", (snap)=>{
  if(!snap) return;

  $("kOnline").textContent = snap.onlineUsers ?? 0;
  $("kRooms").textContent  = snap.rooms ?? 0;
  $("kMatches").textContent = snap.metrics?.matches ?? 0;
  $("kMsgs").textContent    = snap.metrics?.messages ?? 0;

  buildSocketsTable(snap.sockets || []);
  buildRoomsTable(snap.roomDump || []);
});
