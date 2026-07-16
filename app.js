import { auth, googleProvider, db } from "./firebase-config.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, collection, addDoc,
  query, where, onSnapshot, serverTimestamp, getDocs, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- STUN only (free). For networks behind strict/symmetric NAT a TURN
// server is needed for the connection to succeed — see README. ----
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const CHUNK_SIZE = 16 * 1024; // 16KB — safe default for RTCDataChannel
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // pause sending above 4MB buffered

let currentUser = null;
let myHandle = null;
let heartbeatTimer = null;

// live in-memory map of open connections: requestId -> connectionState
const connections = new Map();

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const loginScreen = el("login-screen");
const setupScreen = el("setup-screen");
const appScreen = el("app-screen");
const handleInput = el("handle-input");
const handleStatus = el("handle-status");
const claimBtn = el("claim-btn");
const myAddressLabel = el("my-address-label");
const searchInput = el("search-input");
const searchResult = el("search-result");
const connectionsList = el("connections-list");
const emptyState = el("empty-state");
const incomingPopup = el("incoming-popup");
const incomingFrom = el("incoming-from");
const template = el("connection-template");

function showScreen(screen) {
  [loginScreen, setupScreen, appScreen].forEach(s => s.classList.add("hidden"));
  screen.classList.remove("hidden");
}

// ---------- Auth ----------
el("google-signin-btn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    alert("Sign-in failed: " + err.message);
  }
});

el("signout-btn").addEventListener("click", async () => {
  await teardownAllConnections();
  await setPresence(false);
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    showScreen(loginScreen);
    return;
  }
  currentUser = user;
  const userDoc = await getDoc(doc(db, "users", user.uid));
  if (userDoc.exists() && userDoc.data().handle) {
    myHandle = userDoc.data().handle;
    enterApp();
  } else {
    showScreen(setupScreen);
  }
});

// ---------- Claim address ----------
handleInput.addEventListener("input", async () => {
  const raw = handleInput.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  handleInput.value = raw;
  if (!raw) {
    handleStatus.textContent = "";
    claimBtn.disabled = true;
    return;
  }
  const q = query(collection(db, "users"), where("handle", "==", raw));
  const snap = await getDocs(q);
  if (snap.empty) {
    handleStatus.textContent = `${raw}@sharewithme is available`;
    handleStatus.className = "handle-status ok";
    claimBtn.disabled = false;
  } else {
    handleStatus.textContent = "That address is already taken";
    handleStatus.className = "handle-status bad";
    claimBtn.disabled = true;
  }
});

claimBtn.addEventListener("click", async () => {
  const handle = handleInput.value.trim();
  if (!handle) return;
  await setDoc(doc(db, "users", currentUser.uid), {
    handle,
    email: currentUser.email,
    createdAt: serverTimestamp(),
  });
  myHandle = handle;
  enterApp();
});

async function enterApp() {
  myAddressLabel.textContent = `${myHandle}@sharewithme`;
  showScreen(appScreen);
  await setPresence(true);
  heartbeatTimer = setInterval(() => setPresence(true), 20000);
  window.addEventListener("beforeunload", () => setPresence(false));
  listenForIncomingRequests();
}

async function setPresence(online) {
  if (!currentUser) return;
  await updateDoc(doc(db, "users", currentUser.uid), {
    online,
    lastSeen: serverTimestamp(),
  }).catch(() => {});
}

// ---------- Search ----------
let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const term = searchInput.value.trim().toLowerCase().replace("@sharewithme", "");
  if (!term) { searchResult.classList.add("hidden"); return; }
  searchTimer = setTimeout(() => runSearch(term), 300);
});

async function runSearch(term) {
  const q = query(collection(db, "users"), where("handle", "==", term));
  const snap = await getDocs(q);
  if (snap.empty) {
    searchResult.classList.remove("hidden");
    searchResult.innerHTML = `<span>No one at ${term}@sharewithme</span>`;
    return;
  }
  const docSnap = snap.docs[0];
  const data = docSnap.data();
  if (docSnap.id === currentUser.uid) {
    searchResult.classList.remove("hidden");
    searchResult.innerHTML = `<span>That's you</span>`;
    return;
  }
  searchResult.classList.remove("hidden");
  searchResult.innerHTML = `
    <span class="mono">${data.handle}@sharewithme ${data.online ? "· online" : "· offline"}</span>
    <button class="btn-primary" style="width:auto;padding:8px 16px;" id="request-connect-btn">Request to connect</button>
  `;
  el("request-connect-btn").addEventListener("click", () => sendConnectRequest(docSnap.id, data.handle));
}

// ---------- Requests: send / receive ----------
async function sendConnectRequest(toUid, toHandle) {
  const reqRef = await addDoc(collection(db, "requests"), {
    fromUid: currentUser.uid,
    fromHandle: myHandle,
    toUid,
    toHandle,
    status: "pending",
    createdAt: serverTimestamp(),
  });
  searchResult.innerHTML = `<span>Request sent to ${toHandle}@sharewithme — waiting for them to accept…</span>`;
  // watch for accept/decline
  onSnapshot(doc(db, "requests", reqRef.id), (snap) => {
    const data = snap.data();
    if (!data) return;
    if (data.status === "accepted") {
      startAsCaller(reqRef.id, data.toUid, data.toHandle);
    } else if (data.status === "declined") {
      searchResult.innerHTML = `<span>${toHandle}@sharewithme declined the request</span>`;
    }
  });
}

function listenForIncomingRequests() {
  const q = query(
    collection(db, "requests"),
    where("toUid", "==", currentUser.uid),
    where("status", "==", "pending")
  );
  onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        showIncomingPopup(change.doc.id, change.doc.data());
      }
    });
  });
}

function showIncomingPopup(requestId, data) {
  incomingFrom.textContent = `${data.fromHandle}@sharewithme`;
  incomingPopup.classList.remove("hidden");

  const cleanup = () => incomingPopup.classList.add("hidden");

  el("incoming-accept").onclick = async () => {
    await updateDoc(doc(db, "requests", requestId), { status: "accepted" });
    cleanup();
    startAsCallee(requestId, data.fromUid, data.fromHandle);
  };
  el("incoming-decline").onclick = async () => {
    await updateDoc(doc(db, "requests", requestId), { status: "declined" });
    cleanup();
  };
}

// ---------- WebRTC: caller side ----------
async function startAsCaller(requestId, peerUid, peerHandle) {
  if (connections.has(requestId)) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const dataChannel = pc.createDataChannel("file-transfer");
  const state = createConnectionUI(requestId, peerHandle);
  registerDataChannel(state, dataChannel);
  connections.set(requestId, state);

  const offerCandidates = collection(db, "requests", requestId, "offerCandidates");
  const answerCandidates = collection(db, "requests", requestId, "answerCandidates");

  pc.onicecandidate = (event) => {
    if (event.candidate) addDoc(offerCandidates, event.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => updateConnState(state, pc.connectionState);

  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);
  await updateDoc(doc(db, "requests", requestId), {
    offer: { type: offerDescription.type, sdp: offerDescription.sdp },
  });

  onSnapshot(doc(db, "requests", requestId), (snap) => {
    const data = snap.data();
    if (data?.answer && !pc.currentRemoteDescription) {
      pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });
  onSnapshot(answerCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });

  state.pc = pc;
}

// ---------- WebRTC: callee side ----------
async function startAsCallee(requestId, peerUid, peerHandle) {
  if (connections.has(requestId)) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const state = createConnectionUI(requestId, peerHandle);
  connections.set(requestId, state);

  pc.ondatachannel = (event) => registerDataChannel(state, event.channel);

  const offerCandidates = collection(db, "requests", requestId, "offerCandidates");
  const answerCandidates = collection(db, "requests", requestId, "answerCandidates");

  pc.onicecandidate = (event) => {
    if (event.candidate) addDoc(answerCandidates, event.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => updateConnState(state, pc.connectionState);

  const reqSnap = await getDoc(doc(db, "requests", requestId));
  const offer = reqSnap.data().offer;
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);
  await updateDoc(doc(db, "requests", requestId), {
    answer: { type: answerDescription.type, sdp: answerDescription.sdp },
  });

  onSnapshot(offerCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });

  state.pc = pc;
}

// ---------- Connection UI ----------
function createConnectionUI(requestId, peerHandle) {
  emptyState.classList.add("hidden");
  const node = template.content.cloneNode(true);
  const card = node.querySelector(".connection-card");
  card.dataset.requestId = requestId;
  card.querySelector(".conn-peer").textContent = `${peerHandle}@sharewithme`;
  const stateLabel = card.querySelector(".conn-state");
  const dot = card.querySelector(".dot");
  stateLabel.textContent = "connecting…";
  dot.classList.add("connecting");

  const dropzone = card.querySelector(".dropzone");
  const fileInput = card.querySelector(".file-input");
  const cameraInput = card.querySelector(".camera-input");
  const transferList = card.querySelector(".transfer-list");

  const state = {
    requestId, peerHandle, pc: null, dc: null,
    card, dropzone, transferList,
    incoming: {}, // id -> { chunks: [], meta }
  };

  card.querySelector(".pick-file").addEventListener("click", () => fileInput.click());
  card.querySelector(".pick-camera").addEventListener("click", () => cameraInput.click());
  fileInput.addEventListener("change", (e) => { sendFiles(state, e.target.files); fileInput.value = ""; });
  cameraInput.addEventListener("change", (e) => { sendFiles(state, e.target.files); cameraInput.value = ""; });

  ["dragenter", "dragover"].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag-over"); }));
  dropzone.addEventListener("drop", (e) => sendFiles(state, e.dataTransfer.files));

  card.querySelector(".conn-disconnect").addEventListener("click", () => teardownConnection(requestId, true));

  connectionsList.appendChild(node);
  return state;
}

function updateConnState(state, rtcState) {
  const dot = state.card.querySelector(".dot");
  const label = state.card.querySelector(".conn-state");
  dot.classList.remove("connecting", "connected", "online");
  if (rtcState === "connected") {
    dot.classList.add("connected");
    label.textContent = "encrypted pipeline open";
  } else if (rtcState === "disconnected" || rtcState === "failed" || rtcState === "closed") {
    dot.classList.add("");
    label.textContent = "disconnected";
  } else {
    dot.classList.add("connecting");
    label.textContent = "connecting…";
  }
}

// ---------- Data channel: sending ----------
function registerDataChannel(state, channel) {
  state.dc = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 1 * 1024 * 1024;

  channel.onopen = () => updateConnState(state, "connected");
  channel.onclose = () => updateConnState(state, "closed");

  channel.onmessage = (event) => handleIncomingMessage(state, event.data);
}

async function sendFiles(state, fileList) {
  for (const file of Array.from(fileList)) {
    await sendSingleFile(state, file);
  }
}

function sendSingleFile(state, file) {
  return new Promise(async (resolve) => {
    if (!state.dc || state.dc.readyState !== "open") {
      alert("Pipeline isn't open yet — wait for the connection to finish.");
      return resolve();
    }
    const id = crypto.randomUUID();
    const row = addTransferRow(state, id, file.name, "sending");

    state.dc.send(JSON.stringify({ type: "meta", id, name: file.name, size: file.size, mime: file.type }));

    let offset = 0;
    const buf = await file.arrayBuffer();

    async function sendChunk() {
      if (state.dc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
        state.dc.onbufferedamountlow = () => { state.dc.onbufferedamountlow = null; sendChunk(); };
        return;
      }
      const slice = buf.slice(offset, offset + CHUNK_SIZE);
      state.dc.send(slice);
      offset += slice.byteLength;
      updateTransferRow(row, Math.min(100, Math.round((offset / file.size) * 100)));
      if (offset < buf.byteLength) {
        setTimeout(sendChunk, 0);
      } else {
        state.dc.send(JSON.stringify({ type: "done", id }));
        updateTransferRow(row, 100, "sent");
        resolve();
      }
    }
    sendChunk();
  });
}

// ---------- Data channel: receiving ----------
function handleIncomingMessage(state, data) {
  if (typeof data === "string") {
    const msg = JSON.parse(data);
    if (msg.type === "meta") {
      state.incoming[msg.id] = { meta: msg, chunks: [], received: 0 };
      addTransferRow(state, msg.id, msg.name, "receiving");
    } else if (msg.type === "done") {
      finishIncomingFile(state, msg.id);
    }
    return;
  }
  // binary chunk — find the most recent in-progress incoming file
  const entry = Object.values(state.incoming).find(e => !e.done);
  if (!entry) return;
  entry.chunks.push(data);
  entry.received += data.byteLength;
  const row = state.transferList.querySelector(`[data-id="${entry.meta.id}"]`);
  if (row) updateTransferRow(row, Math.min(100, Math.round((entry.received / entry.meta.size) * 100)));
}

function finishIncomingFile(state, id) {
  const entry = state.incoming[id];
  if (!entry) return;
  entry.done = true;
  const blob = new Blob(entry.chunks, { type: entry.meta.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.meta.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  const row = state.transferList.querySelector(`[data-id="${id}"]`);
  updateTransferRow(row, 100, "saved to downloads");
  delete state.incoming[id];
}

function addTransferRow(state, id, name, statusText) {
  const row = document.createElement("div");
  row.className = "transfer-item";
  row.dataset.id = id;
  row.innerHTML = `
    <div style="flex:1">
      <div class="t-name">${escapeHtml(name)}</div>
      <div class="transfer-bar"><div class="transfer-bar-fill"></div></div>
    </div>
    <span class="t-status">${statusText}</span>
  `;
  state.transferList.prepend(row);
  return row;
}

function updateTransferRow(row, percent, statusText) {
  if (!row) return;
  row.querySelector(".transfer-bar-fill").style.width = percent + "%";
  if (statusText) row.querySelector(".t-status").textContent = statusText;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Disconnect / cleanup ----------
async function teardownConnection(requestId, deleteRemote) {
  const state = connections.get(requestId);
  if (state) {
    if (state.dc) state.dc.close();
    if (state.pc) state.pc.close();
    state.card.remove();
    connections.delete(requestId);
  }
  if (deleteRemote) {
    await cleanupRequestDoc(requestId);
  }
  if (connections.size === 0) emptyState.classList.remove("hidden");
}

async function cleanupRequestDoc(requestId) {
  const subcols = ["offerCandidates", "answerCandidates"];
  for (const sub of subcols) {
    const snap = await getDocs(collection(db, "requests", requestId, sub));
    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  }
  await deleteDoc(doc(db, "requests", requestId)).catch(() => {});
}

async function teardownAllConnections() {
  for (const requestId of Array.from(connections.keys())) {
    await teardownConnection(requestId, true);
  }
}
