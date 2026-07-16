// script.js
// -----------------------------------------------------------------------
// මේකෙන් වෙන්නේ:
//   1. Camera/mic access ගන්නවා (getUserMedia)
//   2. Server එකට connect වෙනවා (Socket.io)
//   3. "Start" click කරාම partner කෙනෙක් හොයනවා
//   4. Partner හම්බුනාම WebRTC connection එකක් හදනවා (offer/answer/ICE)
//   5. දෙන්නාගේම video එකිනෙකට පේන්න සකස් කරනවා
// -----------------------------------------------------------------------

const socket = io();

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statusOverlay = document.getElementById("statusOverlay");
const statusText = document.getElementById("statusText");

const startBtn = document.getElementById("startBtn");
const nextBtn = document.getElementById("nextBtn");
const stopBtn = document.getElementById("stopBtn");
const reportBtn = document.getElementById("reportBtn");

const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

const genderSelect = document.getElementById("genderSelect");
const lookingForSelect = document.getElementById("lookingForSelect");
const interestsInput = document.getElementById("interestsInput");
const sharedInterestsEl = document.getElementById("sharedInterests");

// Autoplay policy නිසා play() block වුනොත්, user video box එක click/tap
// කරාම manually play කරන්න try කරනවා
remoteVideo.addEventListener("click", () => {
  remoteVideo.play().catch((err) => console.error("Manual play failed:", err));
});

let localStream = null;
let peerConnection = null;
let currentPartnerId = null;
let remoteDescSet = false;
let pendingCandidates = []; // remote description එක set වෙන්න කලින් ආපු candidates මෙතන තියාගන්නවා

// -----------------------------------------------------------
// Chat message එකක් screen එකේ පෙන්නන helper function එක
// type: "me" | "stranger" | "system"
// -----------------------------------------------------------
function addChatMessage(text, type) {
  // පළවෙනි "chat කරන්න පුළුවන්" placeholder එක තියෙනවා නම් අයින් කරනවා
  const placeholder = chatMessages.querySelector(".chat-placeholder");
  if (placeholder) placeholder.remove();

  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${type}`;
  msgEl.textContent = text;
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight; // අලුත් message එකට auto-scroll
}

function clearChat() {
  chatMessages.innerHTML = '<div class="chat-placeholder">Partner කෙනෙක් හම්බුනාට පස්සේ chat කරන්න පුළුවන්</div>';
}

// -----------------------------------------------------------
// Interests input එකෙන් ("music, gaming, travel") clean array එකක් හදනවා
// -----------------------------------------------------------
function getInterests() {
  return interestsInput.value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

// Google ලගේ public STUN server එකක් - NAT traversal වලට උදව් කරනවා.
// Production එකකට TURN server එකක් ඕන (coturn වගේ) - direct connection
// fail වුනොත් video relay කරන්න.
// Google ලගේ public STUN server + Open Relay ලගේ free TURN server.
// STUN = direct connection එකකට උදව් කරනවා (එකම/සමාන networks වලදි ප්‍රමාණවත්)
// TURN = direct connection fail වුනොත් (mobile data + WiFi වගේ වෙනස් networks
//        දෙකක ඉන්නකොට බොහෝ වෙලාවට මේක අවශ්‍යයි) video traffic relay කරනවා
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

// -----------------------------------------------------------
// STEP 1: Camera/Mic access ගන්නවා
// -----------------------------------------------------------
async function initCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideo.srcObject = localStream;
    return true;
  } catch (err) {
    statusText.textContent = "❌ Camera/Mic access denied: " + err.message;
    return false;
  }
}

// -----------------------------------------------------------
// STEP 2: "Start" click කරාම - camera enable කරලා partner හොයනවා
// -----------------------------------------------------------
startBtn.addEventListener("click", async () => {
  const ok = await initCamera();
  if (!ok) return;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  genderSelect.disabled = true;
  lookingForSelect.disabled = true;
  interestsInput.disabled = true;
  statusText.textContent = "🔎 Partner කෙනෙක් හොයනවා...";
  statusOverlay.textContent = "Partner කෙනෙක් හොයනවා...";

  socket.emit("find-partner", {
    gender: genderSelect.value,
    lookingFor: lookingForSelect.value,
    interests: getInterests(),
  });
});

// -----------------------------------------------------------
// STEP 3: Server එකෙන් event ලා ලැබෙන විදිහ
// -----------------------------------------------------------
socket.on("waiting", () => {
  statusText.textContent = "⏳ වෙන කෙනෙක් එනකන් බලාගෙන ඉන්නවා...";
});

socket.on("partner-found", async ({ partnerId, initiator, sharedInterests }) => {
  currentPartnerId = partnerId;
  statusText.textContent = "✅ Partner හම්බුනා! Connecting...";
  statusOverlay.textContent = "";
  statusOverlay.style.display = "none"; // overlay background එකම video එකට උඩින් රැඳිලා තියෙන bug එක fix කරනවා
  nextBtn.disabled = false;
  reportBtn.disabled = false;
  chatInput.disabled = false;
  chatSendBtn.disabled = false;
  clearChat();
  addChatMessage("Partner කෙනෙක් හම්බුනා - chat පටන් ගන්න පුළුවන්", "system");

  if (sharedInterests && sharedInterests.length > 0) {
    sharedInterestsEl.textContent = `🎯 Common interests: ${sharedInterests.join(", ")}`;
  } else {
    sharedInterestsEl.textContent = "";
  }

  remoteDescSet = false;
  pendingCandidates = [];

  await createPeerConnection();

  if (initiator) {
    // මේ user ම offer එක හදලා යවනවා
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("signal", { to: partnerId, data: { type: "offer", offer } });
  }
});

socket.on("signal", async ({ from, data }) => {
  if (!peerConnection) return;

  if (data.type === "offer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    remoteDescSet = true;
    await flushPendingCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("signal", { to: from, data: { type: "answer", answer } });
  } else if (data.type === "answer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    remoteDescSet = true;
    await flushPendingCandidates();
  } else if (data.type === "ice-candidate") {
    if (remoteDescSet) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error("ICE candidate error:", err);
      }
    } else {
      // remote description එක තාම set වෙලා නෑ - queue එකේ තියාගන්නවා
      pendingCandidates.push(data.candidate);
    }
  }
});

async function flushPendingCandidates() {
  for (const candidate of pendingCandidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Queued ICE candidate error:", err);
    }
  }
  pendingCandidates = [];
}

socket.on("chat-message", ({ message }) => {
  addChatMessage(message, "stranger");
});

socket.on("partner-left", () => {
  statusText.textContent = "👋 Partner leave වුනා. 'Next' click කරලා අලුත් කෙනෙක්ට යන්න.";
  closePeerConnection();
  statusOverlay.style.display = "flex";
  statusOverlay.textContent = "Partner leave වුනා";
  remoteVideo.srcObject = null;
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  addChatMessage("Partner leave වුනා", "system");
});

// -----------------------------------------------------------
// STEP 4: WebRTC Peer Connection එක හදනවා
// -----------------------------------------------------------
async function createPeerConnection() {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  // අපේ camera/mic tracks peer connection එකට add කරනවා
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  // Partner ගේ video/audio ලැබුනාම remoteVideo එකේ පෙන්නනවා
  peerConnection.ontrack = (event) => {
    console.log("ontrack fired. Streams:", event.streams.length);
    console.log("Track kind:", event.track.kind, "| enabled:", event.track.enabled, "| readyState:", event.track.readyState);

    remoteVideo.srcObject = event.streams[0];

    // සමහර mobile browsers වල srcObject set කරාට පස්සේ
    // explicit play() call එකක් ඕන වෙනවා auto-play වෙන්න
    remoteVideo.play().then(() => {
      console.log("Remote video playing successfully");
    }).catch((err) => {
      console.error("Remote video play() failed:", err);
      statusText.textContent = "⚠️ Video play blocked - screen එක tap කරන්න";
    });
  };

  // ICE candidates හම්බුනා විදිහට partner ට යවනවා
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && currentPartnerId) {
      socket.emit("signal", {
        to: currentPartnerId,
        data: { type: "ice-candidate", candidate: event.candidate },
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log("Connection state:", peerConnection.connectionState);
    if (peerConnection.connectionState === "connected") {
      statusText.textContent = "✅ Connected!";
    } else if (peerConnection.connectionState === "failed") {
      statusText.textContent = "❌ Connection failed. Firewall/network issue වෙන්න පුළුවන්.";
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", peerConnection.iceConnectionState);
  };
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  currentPartnerId = null;
}

// -----------------------------------------------------------
// STEP 5: "Next" button - මේ partner එකෙන් skip කරලා අලුත් කෙනෙක්ට
// -----------------------------------------------------------
nextBtn.addEventListener("click", () => {
  socket.emit("next");
  closePeerConnection();
  remoteVideo.srcObject = null;
  statusOverlay.style.display = "flex";
  statusOverlay.textContent = "Partner කෙනෙක් හොයනවා...";
  statusText.textContent = "🔎 අලුත් partner කෙනෙක් හොයනවා...";
  sharedInterestsEl.textContent = "";
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  clearChat();
  socket.emit("find-partner", {
    gender: genderSelect.value,
    lookingFor: lookingForSelect.value,
    interests: getInterests(),
  });
});

// -----------------------------------------------------------
// STEP 6: "Stop" button - camera/connection සම්පූර්ණයෙන්ම නවත්තනවා
// -----------------------------------------------------------
stopBtn.addEventListener("click", () => {
  socket.emit("leave-queue");
  closePeerConnection();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  startBtn.disabled = false;
  nextBtn.disabled = true;
  stopBtn.disabled = true;
  reportBtn.disabled = true;
  genderSelect.disabled = false;
  lookingForSelect.disabled = false;
  interestsInput.disabled = false;
  sharedInterestsEl.textContent = "";
  statusOverlay.style.display = "flex";
  statusOverlay.textContent = "කැමරාව enable කරලා 'Start' click කරන්න";
  statusText.textContent = "Stopped";
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  clearChat();
});

// -----------------------------------------------------------
// STEP 7: "Report" button - placeholder (production එකේදි ඕන
// real moderation pipeline එකකට connect කරන්න)
// -----------------------------------------------------------
reportBtn.addEventListener("click", () => {
  socket.emit("report", { reason: "user reported" });
  statusText.textContent = "🚩 Report සම්බන්ධ කරගත්තා. ස්තූතියි.";
});

// -----------------------------------------------------------
// STEP 8: Chat message එකක් send කරනවා
// -----------------------------------------------------------
chatForm.addEventListener("submit", (e) => {
  e.preventDefault(); // page reload වෙන එක නවත්තනවා
  const message = chatInput.value.trim();
  if (!message || !currentPartnerId) return;

  socket.emit("chat-message", { to: currentPartnerId, message });
  addChatMessage(message, "me");
  chatInput.value = "";
});
