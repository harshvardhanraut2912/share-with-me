import { auth, googleProvider, db } from "./firebase-config.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, collection, addDoc,
  query, where, onSnapshot, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- STUN only (free). For networks behind strict/symmetric NAT a TURN
// server is needed for the connection to succeed — see README. ----
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const CHUNK_SIZE = 64 * 1024; // 64KB — fewer send() calls than 16KB without hitting per-message limits
const BUFFER_HIGH_WATERMARK = 8 * 1024 * 1024; // in-flight cap before pausing — kept moderate for mobile reliability

let currentUser = null;
let myHandle = null;
let heartbeatTimer = null;

// live in-memory map of open connections: requestId -> connectionState
const connections = new Map();

// ---------- Screen Wake Lock ----------
// Keeps the screen from auto-locking while a pipeline is open — the #1
// cause of a stuck/frozen mobile transfer, since Android suspends a
// backgrounded tab's JS the moment the screen locks. This does NOT
// survive the user manually switching apps (that's an OS-level pause
// no website can prevent) — only screen auto-lock.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch { /* unsupported or denied — non-fatal, transfer just needs the screen kept on manually */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
// Wake locks are auto-released when a tab is hidden — re-acquire on return
// to foreground if a pipeline is still meant to be active.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && connections.size > 0 && !wakeLock) {
    await requestWakeLock();
  }
});

// Global memory map to hold active zip instances per connection: connectionId -> JSZip instance
const activeFolderZips = new Map();

// ---------- Sound effects ----------
// Generated in-browser with the Web Audio API instead of external audio
// files: no dead links, no CORS issues, and (once the tab has had any
// click, which sign-in already provides) no autoplay blocking either.
let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}
function beep(freq = 440, duration = 0.12, type = "sine", delay = 0, volume = 0.15) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, audioCtx.currentTime + delay);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(audioCtx.currentTime + delay);
  osc.stop(audioCtx.currentTime + delay + duration);
}
function playRequestSound()  { unlockAudio(); beep(720, 0.1, "sine"); beep(920, 0.12, "sine", 0.11); }
function playAcceptSound()   { unlockAudio(); beep(600, 0.08, "sine"); beep(900, 0.14, "sine", 0.09); }
function playSendStartSound(){ unlockAudio(); beep(500, 0.07, "square", 0, 0.08); }
function playReceiveStartSound(){ unlockAudio(); beep(1000, 0.07, "square", 0, 0.08); }
function playCompleteSound() { unlockAudio(); beep(660, 0.09); beep(880, 0.09, "sine", 0.09); beep(1100, 0.14, "sine", 0.18); }

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
  unlockAudio();
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
// Global reference to clear previous search listener if user searches again
let searchSnapshotUnsub = null;

async function runSearch(term) {
  // Clear any existing listener from a previous search
  if (searchSnapshotUnsub) {
    searchSnapshotUnsub();
  }

  const q = query(collection(db, "users"), where("handle", "==", term));
  
  searchSnapshotUnsub = onSnapshot(q, (snap) => {
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
    
    // Clear old elements cleanly
    searchResult.innerHTML = "";

    // 1. Create text wrapper status
    const statusText = document.createElement("span");
    statusText.className = "mono";
    
    if (data.online) {
      statusText.innerHTML = `${data.handle}@sharewithme · <span style="color:var(--accent); font-weight:bold;">online</span>`;
      searchResult.appendChild(statusText);

      // 2. Create the connection button element directly instead of raw text strings
      const connectBtn = document.createElement("button");
      connectBtn.className = "btn-primary";
      connectBtn.style.width = "auto";
      connectBtn.style.padding = "8px 16px";
      connectBtn.id = "request-connect-btn";
      connectBtn.textContent = "Request to connect";
      
      // Dynamic inline click execution handler
      connectBtn.onclick = () => {
        // Safe lock: change status instantly so multiple clicks cannot happen
        connectBtn.disabled = true;
        connectBtn.textContent = "Connecting...";
        sendConnectRequest(docSnap.id, data.handle);
      };
      
      searchResult.appendChild(connectBtn);
    } else {
      statusText.innerHTML = `${data.handle}@sharewithme · <span style="color:var(--danger);">offline</span>`;
      searchResult.appendChild(statusText);

      const errorNotice = document.createElement("span");
      errorNotice.style.fontSize = "13px";
      errorNotice.style.color = "var(--ink-soft)";
      errorNotice.style.fontStyle = "italic";
      errorNotice.style.marginLeft = "10px";
      errorNotice.textContent = "Cannot connect while peer is offline";
      searchResult.appendChild(errorNotice);
    }
  });
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

  // Play high-tech sonar signal when request pops up
  playRequestSound();

  const cleanup = () => incomingPopup.classList.add("hidden");

  el("incoming-accept").onclick = async () => {
    // Play the accept chime right away, on the user gesture — browsers only
    // allow audio to play in response to a real click, so this must happen
    // here rather than later once the async Firestore/WebRTC work resolves.
    playAcceptSound();
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

  // FIX: Listen for the offer to be created by the caller instead of guessing when it's ready
  const unsub = onSnapshot(doc(db, "requests", requestId), async (snap) => {
    const data = snap.data();
    if (data?.offer && !pc.currentRemoteDescription) {
      // We got the offer! Stop listening to this document's updates
      unsub(); 
      
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);
      await updateDoc(doc(db, "requests", requestId), {
        answer: { type: answerDescription.type, sdp: answerDescription.sdp },
      });
    }
  });

  onSnapshot(offerCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });

  state.pc = pc;
}

// ---------- Connection UI (Upgraded for aesthetics) ----------
function createConnectionUI(requestId, peerHandle) {
  emptyState.classList.add("hidden");
  const node = template.content.cloneNode(true);
  const card = node.querySelector(".connection-card");
  card.dataset.requestId = requestId;
  card.querySelector(".conn-peer").textContent = `${peerHandle}@sharewithme`;
  const stateLabel = card.querySelector(".conn-state");
  const dot = card.querySelector(".dot");
  stateLabel.textContent = "awaiting handshake…";
  dot.classList.add("connecting");

  const dropzone = card.querySelector(".dropzone");
  const fileInput = card.querySelector(".file-input");
  const folderInput = card.querySelector(".folder-input");
  const transferList = card.querySelector(".transfer-list");

  const state = {
    requestId, peerHandle, pc: null, dc: null,
    card, dropzone, transferList,
    incoming: {},
    fileQueue: [], // Track sequential transmissions smoothly
    isSending: false
  };

  // Wire UI Element Interactivity
  card.querySelector(".pick-file").addEventListener("click", () => fileInput.click());
  card.querySelector(".pick-folder").addEventListener("click", () => folderInput.click());
  
  fileInput.addEventListener("change", (e) => { sendFiles(state, e.target.files); fileInput.value = ""; });
  folderInput.addEventListener("change", (e) => { sendFiles(state, e.target.files); folderInput.value = ""; });

  ["dragenter", "dragover"].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag-over"); }));
  dropzone.addEventListener("drop", (e) => sendFiles(state, e.dataTransfer.files));

  card.querySelector(".conn-disconnect").addEventListener("click", () => teardownConnection(requestId, true));

  connectionsList.appendChild(node);
  return state;
}

// Upgraded updateConnState to toggle security dashboard states
function updateConnState(state, rtcState) {
  const dot = state.card.querySelector(".dot");
  const label = state.card.querySelector(".conn-state");
  const cryptoBar = state.card.querySelector(".crypto-stream-box");
  
  dot.classList.remove("connecting", "connected", "online");
  if (rtcState === "connected") {
    dot.classList.add("connected");
    label.textContent = "SECURE TUNNEL OPEN";
    if (cryptoBar) cryptoBar.classList.remove("hidden");
    requestWakeLock();
  } else if (rtcState === "disconnected" || rtcState === "failed" || rtcState === "closed") {
    label.textContent = "PIPELINE TERMINATED";
    if (cryptoBar) cryptoBar.classList.add("hidden");
    // Mark any transfer that was still in progress as failed instead of
    // leaving its progress bar frozen forever with no explanation — mobile
    // networks in particular can drop the connection mid-transfer (screen
    // lock, tab backgrounding, NAT timeout) with no warning.
    state.card.querySelectorAll('.transfer-item[data-status="sending"], .transfer-item[data-status="receiving"]')
      .forEach(row => {
        row.setAttribute("data-status", "failed");
        const statusEl = row.querySelector(".t-status");
        if (statusEl) statusEl.textContent = "connection lost mid-transfer — try again";
      });
  } else {
    dot.classList.add("connecting");
    label.textContent = "ESTABLISHING CIPHER…";
  }
}

// ---------- Multiple File & Folder Queue Processing Engine ----------
async function sendFiles(state, fileList) {
  // Add all files into a structured queue array
  for (const file of Array.from(fileList)) {
    // If webkitRelativePath exists, use it so the receiver knows the folder tree
    const virtualPath = file.webkitRelativePath || file.name;
    state.fileQueue.push({ file, path: virtualPath });
  }

  // Update visual queue indicators
  const queueBar = state.card.querySelector(".queue-stats");
  const queueCounter = state.card.querySelector("#queue-count");
  if (state.fileQueue.length > 0) {
    if (queueBar) queueBar.classList.remove("hidden");
    if (queueCounter) queueCounter.textContent = `${state.fileQueue.length} payload(s) queued`;
  }

  // If the engine isn't currently transferring, start firing tasks
  if (!state.isSending) {
    processQueue(state);
  }
}

async function processQueue(state) {
  if (state.fileQueue.length === 0) {
    state.isSending = false;
    const queueBar = state.card.querySelector(".queue-stats");
    if (queueBar) queueBar.classList.add("hidden");
    return;
  }

  state.isSending = true;
  const item = state.fileQueue.shift();
  const queueCounter = state.card.querySelector("#queue-count");
  if (queueCounter) queueCounter.textContent = `${state.fileQueue.length + 1} payload(s) working`;

  // Send the individual item (passing custom relational directory paths)
  await sendSingleFileExtended(state, item.file, item.path);
  
  // Recursively trigger next file
  processQueue(state);
}

// Waits for the RTCDataChannel to actually reach "open" before sending,
// instead of failing immediately if the handshake is still in progress.
// Gives up after 20s (covers a genuinely stuck/failed connection) so the
// UI can tell the user instead of hanging forever.
function waitForOpenChannel(state, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (state.dc && state.dc.readyState === "open") return resolve();
    const start = performance.now();
    const check = () => {
      if (state.dc && state.dc.readyState === "open") return resolve();
      if (performance.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(check, 250);
    };
    check();
  });
}

function sendSingleFileExtended(state, file, customPath) {
  return new Promise(async (resolve) => {
    const id = crypto.randomUUID();
    // UI shows the path name layout (e.g. MyFolder/Sub/image.png)
    const row = addTransferRow(state, id, customPath, "waiting for secure pipeline…");
    row.setAttribute("data-status", "sending");

    if (!state.dc || state.dc.readyState !== "open") {
      try {
        await waitForOpenChannel(state);
      } catch {
        updateTransferRow(row, 0, "connection never opened — check your network/TURN setup");
        row.setAttribute("data-status", "failed");
        return resolve();
      }
    }
    updateTransferRow(row, 0, "encrypting…");
    playSendStartSound();

    // Inject speed metrics container beneath standard metadata rows
    const speedMetaDiv = document.createElement("div");
    speedMetaDiv.className = "t-speed-meta";
    const containerDiv = row.querySelector("div");
    if (containerDiv) containerDiv.appendChild(speedMetaDiv);

    state.dc.send(JSON.stringify({ 
      type: "meta", 
      id, 
      name: customPath, 
      size: file.size, 
      mime: file.type 
    }));

    let offset = 0;
    const buf = await file.arrayBuffer();

    // Performance metrics variables
    let startTime = performance.now();
    let lastLoggedBytes = 0;
    let lastUiUpdate = 0;

    function sendChunk() {
      // Send as many chunks as the buffer allows, back-to-back, with NO
      // artificial delay between them (setTimeout(0) throttles to ~4ms
      // per call in real browsers — over thousands of small chunks that
      // alone was capping speed to a few MB/s regardless of actual link
      // speed). We only stop when the channel's real send buffer is full,
      // and resume via the genuine "bufferedamountlow" event, not polling.
      while (offset < buf.byteLength) {
        if (state.dc.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          // If the buffer never drains within 15s, the connection is
          // almost certainly dead (common on mobile: screen lock, tab
          // backgrounding, NAT timeout) — fail visibly instead of hanging.
          const stallTimer = setTimeout(() => {
            state.dc.onbufferedamountlow = null;
            row.setAttribute("data-status", "failed");
            updateTransferRow(row, Math.round((offset / buf.byteLength) * 100), "stalled — connection likely dropped, try again");
            resolve();
          }, 15000);
          state.dc.onbufferedamountlow = () => {
            clearTimeout(stallTimer);
            state.dc.onbufferedamountlow = null;
            sendChunk();
          };
          return;
        }
        const slice = buf.slice(offset, offset + CHUNK_SIZE);
        state.dc.send(slice);
        offset += slice.byteLength;

        // Throttle UI/DOM writes to a few times a second — updating on
        // every single chunk (there can be tens of thousands for a large
        // file) turns the progress bar itself into a bottleneck.
        const now = performance.now();
        if (now - lastUiUpdate >= 150 || offset >= buf.byteLength) {
          const elapsedSec = (now - startTime) / 1000;
          if (elapsedSec >= 0.4) {
            const bytesSentInPeriod = offset - lastLoggedBytes;
            const speedBps = bytesSentInPeriod / elapsedSec;
            const speedMBps = (speedBps / (1024 * 1024)).toFixed(1);
            const bytesLeft = file.size - offset;
            const etaSec = speedBps > 0 ? Math.ceil(bytesLeft / speedBps) : 0;
            speedMetaDiv.innerHTML = `<span>⚡ ${speedMBps} MB/s</span> <span>⏳ ${etaSec}s left</span>`;
            startTime = now;
            lastLoggedBytes = offset;
          }
          updateTransferRow(row, Math.min(100, Math.round((offset / file.size) * 100)));
          lastUiUpdate = now;
        }
      }

      state.dc.send(JSON.stringify({ type: "done", id }));
      row.setAttribute("data-status", "completed");
      speedMetaDiv.innerHTML = ""; // Clear speeds on finish
      updateTransferRow(row, 100, "delivered securely");
      playCompleteSound();
      resolve();
    }
    sendChunk();
  });
}

// ---------- Data channel: registration ----------
function registerDataChannel(state, channel) {
  state.dc = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 1 * 1024 * 1024;

  channel.onopen = () => updateConnState(state, "connected");
  channel.onclose = () => updateConnState(state, "closed");

  channel.onmessage = (event) => handleIncomingMessage(state, event.data);
}

// ---------- Data Channel: Upgraded Receiving Engine ----------
function handleIncomingMessage(state, data) {
  if (typeof data === "string") {
    const msg = JSON.parse(data);
    if (msg.type === "meta") {
      state.incoming[msg.id] = { meta: msg, chunks: [], received: 0 };
      const row = addTransferRow(state, msg.id, msg.name, "receiving…");
      row.setAttribute("data-status", "receiving");
      playReceiveStartSound();
    } else if (msg.type === "done") {
      finishIncomingFile(state, msg.id);
    }
    return;
  }
  
  // Binary chunk processing loop
  const entry = Object.values(state.incoming).find(e => !e.done);
  if (!entry) return;
  entry.chunks.push(data);
  entry.received += data.byteLength;

  // Cache the row element and throttle DOM writes — querying + updating
  // the DOM on every single incoming chunk (there can be tens of
  // thousands for a large file) is itself a bottleneck.
  if (!entry.row) entry.row = state.transferList.querySelector(`[data-id="${entry.meta.id}"]`);
  const now = performance.now();
  if (!entry.lastUiUpdate || now - entry.lastUiUpdate >= 150 || entry.received >= entry.meta.size) {
    if (entry.row) updateTransferRow(entry.row, Math.min(100, Math.round((entry.received / entry.meta.size) * 100)));
    entry.lastUiUpdate = now;
  }
}

async function finishIncomingFile(state, id) {
  const entry = state.incoming[id];
  if (!entry) return;
  entry.done = true;

  const blob = new Blob(entry.chunks, { type: entry.meta.mime || "application/octet-stream" });
  const relativePath = entry.meta.name; // e.g. "MyPhotos/Vacation/pic1.jpg"
  
  // Check if this payload belongs to a folder structure
  if (relativePath.includes("/")) {
    const pathParts = relativePath.split("/");
    const rootFolderName = pathParts[0]; // Extract the main input folder name

    // If it's the first file of this folder, initialize a new JSZip profile
  // If it's the first file of this folder, initialize a new JSZip profile
    if (!activeFolderZips.has(state.requestId)) {
      activeFolderZips.set(state.requestId, {
        zip: new JSZip(),
        rootName: rootFolderName,
        pendingCount: 0,
        uiRows: [] // Fix: Removed the accidental duplicate brackets
      });
    }
    const folderSession = activeFolderZips.get(state.requestId);
    folderSession.pendingCount++;
    
    const row = state.transferList.querySelector(`[data-id="${id}"]`);
    if (row) {
      updateTransferRow(row, 100, "staged in package");
      folderSession.uiRows.push({ row, id });
    }

    // Read blob as ArrayBuffer and pack it into the Zip container with its nested paths
    const arrayBuffer = await blob.arrayBuffer();
    folderSession.zip.file(relativePath, arrayBuffer);

    // Debounce check: Wait a split second to see if more files from the folder stream are loading
    clearTimeout(folderSession.timeout);
    folderSession.timeout = setTimeout(async () => {
      // No more files arrived for 1.5 seconds -> Compile and ship the folder payload
      const finalSession = activeFolderZips.get(state.requestId);
      if (!finalSession) return;
      
      // Update the UI items to let the user know compilation has begun
      finalSession.uiRows.forEach(item => {
        updateTransferRow(item.row, 100, "generating archive…");
      });

      // Generate the production zip archive asynchronously
      const content = await finalSession.zip.generateAsync({ type: "blob" });
      
      // Trigger native download window for the full folder zip
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${finalSession.rootName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      
      // Complete UI updates
      finalSession.uiRows.forEach(item => {
        item.row.setAttribute("data-status", "completed");
        updateTransferRow(item.row, 100, "folder downloaded");
      });

      // Play victory chime when zip archive downloads successfully
      playCompleteSound();

      URL.revokeObjectURL(url);
      activeFolderZips.delete(state.requestId);
    }, 1500);

  } else {
    // Standard isolated single file fallback execution loop
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.meta.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    const row = state.transferList.querySelector(`[data-id="${id}"]`);
    if (row) {
      row.setAttribute("data-status", "completed");
      updateTransferRow(row, 100, "saved securely");
    }

    // Play victory chime on standalone file completion
    playCompleteSound();
  }

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
  const fillEl = row.querySelector(".transfer-bar-fill");
  const statusEl = row.querySelector(".t-status");
  if (fillEl) fillEl.style.width = percent + "%";
  if (statusText && statusEl) statusEl.textContent = statusText;
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
  if (connections.size === 0) {
    emptyState.classList.remove("hidden");
    releaseWakeLock();
  }
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