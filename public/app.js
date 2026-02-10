// public/app.js
const socket = io();

// ---------- persistent clientId ----------
const LS_KEY = "sayra_client_id";
let clientId = localStorage.getItem(LS_KEY);
if (!clientId) {
  clientId = "c_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  localStorage.setItem(LS_KEY, clientId);
}

const el = (id) => document.getElementById(id);

const statusBox = el("status");
const chatBody = el("chatBody");
const typingLine = el("typingLine");

const nameIn = el("name");
const genderSel = el("gender");
const levelSel = el("level");

const findBtn = el("findBtn");
const leaveBtn = el("leaveBtn");
const sendBtn = el("sendBtn");
const msgIn = el("msg");

const voiceOnBtn = el("voiceOnBtn");
const voiceOffBtn = el("voiceOffBtn");
const reportBtn = el("reportBtn");

const onlineEl = el("online");
const waitingCountEl = el("waitingCount");
const roomsCountEl = el("roomsCount");
const whoEl = el("who");

let my = { name:"", gender:"male", level:"B1" };
let partner = null;
let roomId = null;

// Voice/WebRTC
let pc = null;
let localStream = null;
const remoteAudio = document.getElementById("remoteAudio");
const RTC_CFG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ---------- UI helpers ----------
function setStatus(text, type="info"){
  statusBox.textContent = text;
  statusBox.style.color =
    type === "error" ? "rgba(239,68,68,.95)" :
    type === "ok" ? "rgba(34,197,94,.95)" :
    type === "wait" ? "rgba(245,158,11,.95)" :
    "rgba(255,255,255,.70)";
}
function setChatEnabled(on){
  msgIn.disabled = !on;
  sendBtn.disabled = !on;

  leaveBtn.disabled = !on;
  reportBtn.disabled = !on;

  voiceOnBtn.disabled = !on;
  voiceOffBtn.disabled = !on;

  findBtn.disabled = on;
}
function clearChat(){
  chatBody.innerHTML = "";
  typingLine.textContent = "";
}
function addBubble({from, text, at}, kind="user"){
  const wrap = document.createElement("div");
  wrap.className = "bubble" +
    (from === my.name ? " me" : "") +
    (kind === "sys" ? " sys" : "");
  wrap.textContent = text;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${from} • ${new Date(at || Date.now()).toLocaleTimeString()}`;
  wrap.appendChild(meta);

  chatBody.appendChild(wrap);
  chatBody.scrollTop = chatBody.scrollHeight;
}
function updateWho(){
  if(!partner){
    whoEl.textContent = "Partner topilmagan.";
    return;
  }
  whoEl.textContent =
    `Siz: ${my.name} (${my.level}, ${my.gender})\n` +
    `Partner: ${partner.name} (${partner.level}, ${partner.gender})`;
}

function idleState(msg){
  stopVoice();
  roomId = null;
  partner = null;
  updateWho();
  setChatEnabled(false);
  findBtn.disabled = false;
  setStatus(msg || "Tayyor.", "info");
}

// ---------- socket events ----------
socket.on("connect", () => {
  socket.emit("hello", { clientId });
});

socket.on("hello_ok", (d) => {
  if (d?.clientId) clientId = d.clientId;
});

socket.on("global_stats", (s) => {
  onlineEl.textContent = s.onlineUsers ?? 0;
  roomsCountEl.textContent = s.rooms ?? 0;

  const q = s.queue || {};
  let total = 0;
  for (const k in q) total += Number(q[k] || 0);
  waitingCountEl.textContent = total;
});

socket.on("status", (s) => {
  if (s.type === "waiting") setStatus(s.message, "wait");
  else if (s.type === "error") setStatus(s.message, "error");
  else if (s.type === "matched") setStatus(s.message, "ok");
  else setStatus(s.message, "info");
});

socket.on("matched", (data) => {
  roomId = data.roomId;
  my = data.you;
  partner = data.partner;

  updateWho();
  setChatEnabled(true);
  clearChat();

  addBubble({ from:"SYSTEM", text:"✅ Match topildi. Chat faqat 2 kishilik.", at:Date.now() }, "sys");
  socket.emit("get_history");
});

socket.on("history", (h) => {
  (h?.items || []).forEach(m => addBubble(m, "user"));
});

socket.on("message", (m) => addBubble(m, "user"));

let typingTimer = null;
socket.on("typing", (t) => {
  if (!partner) return;
  if (t.on) {
    typingLine.textContent = `${t.from} typing…`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => (typingLine.textContent = ""), 1200);
  } else {
    typingLine.textContent = "";
  }
});

socket.on("partner_left", () => {
  addBubble({ from:"SYSTEM", text:"Partner chiqib ketdi. Yangi partner qidiring.", at:Date.now() }, "sys");
  idleState("Partner chiqib ketdi. Yana Find partner bosing.");
});

socket.on("room_closed", () => {
  addBubble({ from:"SYSTEM", text:"Room yopildi.", at:Date.now() }, "sys");
  idleState("Room yopildi. Yana Find partner bosing.");
});

// ---------- actions ----------
findBtn.addEventListener("click", () => {
  const name = nameIn.value.trim();
  const gender = genderSel.value;
  const level = levelSel.value;

  if (!name) return setStatus("Ism kiriting.", "error");

  my = { name, gender, level };
  partner = null;
  roomId = null;

  updateWho();
  setChatEnabled(false);
  clearChat();

  setStatus("Qidirilyapti…", "wait");
  socket.emit("find_partner", { clientId, name, gender, level });
});

leaveBtn.addEventListener("click", () => {
  socket.emit("leave_chat");
  idleState("Chiqildi. Yana Find partner bosing.");
});

reportBtn.addEventListener("click", () => {
  socket.emit("report_partner");
  setStatus("Report yuborildi.", "info");
});

function send(){
  const text = msgIn.value.trim();
  if (!text) return;
  socket.emit("send_message", { text });
  msgIn.value = "";
  socket.emit("typing", { on:false });
}

sendBtn.addEventListener("click", send);
msgIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
  else socket.emit("typing", { on:true });
});
msgIn.addEventListener("blur", () => socket.emit("typing", { on:false }));

// ---------- voice / WebRTC ----------
async function ensureLocalAudio(){
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  return localStream;
}

async function startVoice(){
  if (!roomId || !partner) return setStatus("Avval match bo‘ling.", "error");
  if (pc) return setStatus("Voice allaqachon yoqilgan.", "info");

  try {
    const stream = await ensureLocalAudio();
    pc = new RTCPeerConnection(RTC_CFG);

    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = (e) => {
      remoteAudio.srcObject = e.streams[0];
      remoteAudio.play().catch(()=>{});
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit("voice_ice", e.candidate);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("voice_offer", offer);

    setStatus("🎙 Voice yoqildi (offer yuborildi)", "ok");
  } catch {
    setStatus("Mikrofon ruxsati berilmadi yoki xato.", "error");
    stopVoice();
  }
}

async function handleOffer(offer){
  try{
    if (!pc) {
      const stream = await ensureLocalAudio();
      pc = new RTCPeerConnection(RTC_CFG);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.ontrack = (e) => {
        remoteAudio.srcObject = e.streams[0];
        remoteAudio.play().catch(()=>{});
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit("voice_ice", e.candidate);
      };
    }

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("voice_answer", answer);

    setStatus("🎧 Voice ulanish (answer yuborildi)", "ok");
  } catch {
    setStatus("Voice offer qabul qilishda xato.", "error");
    stopVoice();
  }
}

async function handleAnswer(answer){
  try{
    if (!pc) return;
    await pc.setRemoteDescription(answer);
    setStatus("✅ Voice connection ready", "ok");
  } catch {
    setStatus("Voice answer qo‘yishda xato.", "error");
  }
}

async function handleIce(cand){
  try{
    if (pc) await pc.addIceCandidate(cand);
  } catch {}
}

function stopVoice(){
  try { pc?.close(); } catch {}
  pc = null;
  try { localStream?.getTracks().forEach(t => t.stop()); } catch {}
  localStream = null;
  setStatus("🔇 Voice o‘chirildi.", "info");
}

voiceOnBtn.addEventListener("click", startVoice);
voiceOffBtn.addEventListener("click", stopVoice);

socket.on("voice_offer", handleOffer);
socket.on("voice_answer", handleAnswer);
socket.on("voice_ice", handleIce);

// default
setChatEnabled(false);
updateWho();
