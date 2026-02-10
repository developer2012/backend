"use strict";

const $ = (id) => document.getElementById(id);
const fmtTime = (t) => new Date(t || Date.now()).toLocaleTimeString();

function toast(msg, kind="ok"){
  const wrap = $("toastWrap");
  const t = document.createElement("div");
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// persistent clientId
const LS_KEY = "sayra_client_id";
let clientId = localStorage.getItem(LS_KEY);
if(!clientId){
  clientId = "c_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  localStorage.setItem(LS_KEY, clientId);
}

const socket = io();

// UI
const onlineEl = $("online");
const waitingCountEl = $("waitingCount");
const roomsCountEl = $("roomsCount");

const nameIn = $("name");
const genderSel = $("gender");
const levelSel = $("level");

const findBtn = $("findBtn");
const leaveBtn = $("leaveBtn");
const voiceOnBtn = $("voiceOnBtn");
const voiceOffBtn = $("voiceOffBtn");
const reportBtn = $("reportBtn");

const statusBox = $("status");
const whoEl = $("who");
const typingLine = $("typingLine");
const chatBody = $("chatBody");
const msgIn = $("msg");
const sendBtn = $("sendBtn");

// Icebreaker UI
const iceBar = $("iceBar");
const iceCount = $("iceCount");
const iceQ = $("iceQ");
const icePrev = $("icePrev");
const iceNext = $("iceNext");

// State
let my = { name:"", gender:"male", level:"B1" };
let partner = null;
let roomId = null;
let lastPartnerReadId = null;

// typing
let typingTimer = null;
let typingLocal = false;

// ice state
let ice = { questions:[], index:0, total:0 };

// voice
let pc = null;
let localStream = null;
const remoteAudio = $("remoteAudio");
const RTC_CFG = { iceServers: [{ urls:"stun:stun.l.google.com:19302" }] };

function setStatus(text, type="info"){
  statusBox.textContent = text;
  statusBox.style.color =
    type==="error" ? "rgba(239,68,68,.95)" :
    type==="ok"    ? "rgba(34,197,94,.95)" :
    type==="wait"  ? "rgba(245,158,11,.95)" :
    "rgba(255,255,255,.75)";
}

function setChatEnabled(on){
  msgIn.disabled = !on;
  sendBtn.disabled = !on;
  leaveBtn.disabled = !on;
  reportBtn.disabled = !on;
  voiceOnBtn.disabled = !on;
  voiceOffBtn.disabled = !on;
  findBtn.disabled = on;

  if(!on){
    iceBar.style.display = "none";
    ice = { questions:[], index:0, total:0 };
  }
}

function updateWho(){
  if(!partner){
    whoEl.textContent = "Partner topilmagan.";
    return;
  }
  whoEl.textContent =
    `Siz: ${my.name} (${my.level}, ${my.gender})\n`+
    `Partner: ${partner.name} (${partner.level}, ${partner.gender})`;
}

function clearChat(){
  chatBody.innerHTML = "";
  typingLine.textContent = "";
  lastPartnerReadId = null;
}

function addBubble({from, text, at, id}, kind="user"){
  const wrap = document.createElement("div");
  wrap.className = "bubble" + (from === my.name ? " me" : "") + (kind === "sys" ? " sys" : "");
  wrap.textContent = text;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${from} • ${fmtTime(at)}` + (from===my.name && id && lastPartnerReadId===id ? " • ✅ read" : "");
  wrap.appendChild(meta);

  wrap.dataset.msgId = id || "";
  chatBody.appendChild(wrap);
  chatBody.scrollTop = chatBody.scrollHeight;
}

function markReadLabel(){
  if(!lastPartnerReadId) return;
  const bubbles = Array.from(chatBody.querySelectorAll(".bubble.me"));
  for(const b of bubbles){
    const id = b.dataset.msgId;
    if(id && id === lastPartnerReadId){
      const meta = b.querySelector(".meta");
      if(meta && !meta.textContent.includes("✅ read")){
        meta.textContent = meta.textContent + " • ✅ read";
      }
    }
  }
}

function renderIce(){
  if(!ice.questions.length){
    iceBar.style.display = "none";
    return;
  }
  iceBar.style.display = "block";
  iceCount.textContent = `${ice.index+1}/${ice.total}`;
  iceQ.textContent = ice.questions[ice.index] || "—";
  icePrev.disabled = ice.index <= 0;
  iceNext.disabled = ice.index >= ice.total-1;
}

function stopVoice(){
  try{ pc?.close(); }catch{}
  pc = null;
  try{ localStream?.getTracks().forEach(t=>t.stop()); }catch{}
  localStream = null;
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

// ---------- ICE buttons ----------
icePrev.addEventListener("click", ()=> roomId && socket.emit("ice_prev"));
iceNext.addEventListener("click", ()=> roomId && socket.emit("ice_next"));

// ---------- socket ----------
socket.on("connect", ()=>{
  socket.emit("hello", { clientId });
});
socket.on("hello_ok", (d)=>{
  if(d?.clientId) clientId = d.clientId;
});

socket.on("global_stats", (s)=>{
  onlineEl.textContent = s.onlineUsers ?? 0;
  roomsCountEl.textContent = s.rooms ?? 0;
  const q = s.queue || {};
  let total = 0;
  for(const k in q) total += Number(q[k] || 0);
  waitingCountEl.textContent = total;
});

socket.on("status", (s)=>{
  if(s.type==="waiting") setStatus(s.message, "wait");
  else if(s.type==="error") setStatus(s.message, "error");
  else if(s.type==="matched") setStatus(s.message, "ok");
  else setStatus(s.message, "info");
});

socket.on("matched", (data)=>{
  roomId = data.roomId;
  my = data.you;
  partner = data.partner;

  updateWho();
  setChatEnabled(true);
  clearChat();
  addBubble({from:"SYSTEM", text:"✅ Match topildi. Pastdagi savollar orqali gap boshlang!", at:Date.now()}, "sys");
  toast("Match topildi ✅", "ok");
  socket.emit("get_history");
});

socket.on("history", (h)=>{
  (h?.items || []).forEach(m => addBubble({from:m.from, text:m.text, at:m.at, id:m.id}, "user"));
});

// icebreaker
socket.on("icebreaker", (p)=>{
  ice.questions = p.questions || [];
  ice.index = Number(p.index || 0);
  ice.total = Number(p.total || ice.questions.length || 0);
  renderIce();
});

socket.on("message", (m)=>{
  addBubble({from:m.from, text:m.text, at:m.at, id:m.id}, "user");

  if(partner && m.from === partner.name && m.id){
    socket.emit("read_up_to", { msgId: m.id });
  }
});

socket.on("read_up_to", (r)=>{
  lastPartnerReadId = r.msgId;
  markReadLabel();
});

socket.on("typing", (t)=>{
  if(!partner) return;
  if(t.on){
    typingLine.textContent = `${t.from} typing…`;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(()=> typingLine.textContent="", 1100);
  } else typingLine.textContent = "";
});

socket.on("partner_left", ()=>{
  addBubble({from:"SYSTEM", text:"Partner chiqib ketdi. Yangi partner qidiring.", at:Date.now()}, "sys");
  toast("Partner chiqib ketdi", "warn");
  idleState("Partner chiqib ketdi. Yana Find partner bosing.");
});

socket.on("room_closed", ()=>{
  addBubble({from:"SYSTEM", text:"Room yopildi.", at:Date.now()}, "sys");
  idleState("Room yopildi. Yana Find partner bosing.");
});

// ---------- actions ----------
findBtn.addEventListener("click", ()=>{
  const name = nameIn.value.trim();
  const gender = genderSel.value;
  const level = levelSel.value;
  if(!name) return setStatus("Ism kiriting.", "error");

  my = { name, gender, level };
  partner = null;
  roomId = null;

  updateWho();
  setChatEnabled(false);
  clearChat();
  setStatus("Qidirilyapti…", "wait");

  socket.emit("find_partner", { clientId, name, gender, level });
});

leaveBtn.addEventListener("click", ()=>{
  socket.emit("leave_chat");
  toast("Chiqildi", "warn");
  idleState("Chiqildi. Yana Find partner bosing.");
});

reportBtn.addEventListener("click", ()=>{
  socket.emit("report_partner");
  toast("Report yuborildi", "warn");
  setStatus("Report yuborildi.", "info");
});

function send(){
  const text = msgIn.value.trim();
  if(!text) return;
  socket.emit("send_message", { text });
  msgIn.value = "";
  if(typingLocal){
    typingLocal = false;
    socket.emit("typing", { on:false });
  }
}

sendBtn.addEventListener("click", send);

msgIn.addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){
    e.preventDefault();
    send();
    return;
  }
  if(!typingLocal){
    typingLocal = true;
    socket.emit("typing", { on:true });
  }
});

msgIn.addEventListener("blur", ()=>{
  if(typingLocal){
    typingLocal = false;
    socket.emit("typing", { on:false });
  }
});

// ---------- voice ----------
async function ensureLocalAudio(){
  if(localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  return localStream;
}

async function startVoice(){
  if(!roomId || !partner) return setStatus("Avval match bo‘ling.", "error");
  if(pc) return setStatus("Voice allaqachon yoqilgan.", "info");
  try{
    const stream = await ensureLocalAudio();
    pc = new RTCPeerConnection(RTC_CFG);
    stream.getTracks().forEach(t=> pc.addTrack(t, stream));
    pc.ontrack = (e)=>{ remoteAudio.srcObject = e.streams[0]; remoteAudio.play().catch(()=>{}); };
    pc.onicecandidate = (e)=>{ if(e.candidate) socket.emit("voice_ice", e.candidate); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("voice_offer", offer);

    toast("Voice ON 🎙", "ok");
    setStatus("🎙 Voice yoqildi", "ok");
  } catch {
    setStatus("Mikrofon ruxsati yo‘q yoki xato.", "error");
    toast("Mic permission kerak", "bad");
    stopVoice();
  }
}

async function handleOffer(payload){
  try{
    const offer = payload.offer;
    if(!pc){
      const stream = await ensureLocalAudio();
      pc = new RTCPeerConnection(RTC_CFG);
      stream.getTracks().forEach(t=> pc.addTrack(t, stream));
      pc.ontrack = (e)=>{ remoteAudio.srcObject = e.streams[0]; remoteAudio.play().catch(()=>{}); };
      pc.onicecandidate = (e)=>{ if(e.candidate) socket.emit("voice_ice", e.candidate); };
    }
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("voice_answer", answer);
    setStatus("🎧 Voice ulanmoqda…", "ok");
  } catch {
    setStatus("Voice offer qabul qilishda xato.", "error");
    stopVoice();
  }
}

async function handleAnswer(payload){
  try{
    if(!pc) return;
    await pc.setRemoteDescription(payload.answer);
    setStatus("✅ Voice connection ready", "ok");
  } catch {
    setStatus("Voice answer qo‘yishda xato.", "error");
  }
}

async function handleIce(payload){
  try{
    if(pc && payload.candidate) await pc.addIceCandidate(payload.candidate);
  } catch {}
}

voiceOnBtn.addEventListener("click", startVoice);
voiceOffBtn.addEventListener("click", ()=>{
  stopVoice();
  toast("Voice OFF", "warn");
  setStatus("🔇 Voice o‘chirildi.", "info");
});

socket.on("voice_offer", handleOffer);
socket.on("voice_answer", handleAnswer);
socket.on("voice_ice", handleIce);

// init
setChatEnabled(false);
updateWho();
setStatus("Tayyor. Ism+gender+daraja tanlab Find partner bosing.", "info");
