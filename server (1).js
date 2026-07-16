// server.js
// -----------------------------------------------------------------------
// මේක තමයි "signaling server" එක.
// මේකේ වැඩේ:
//   1. Users "waiting queue" එකකට දානවා (Start click කරාම)
//   2. දෙන්නෙක් waiting නම්, ඒ දෙන්නා pair කරනවා
//   3. WebRTC handshake messages (offer/answer/ICE) දෙපැත්තටම relay කරනවා
//   4. Video/audio stream එක මේ server එකෙන් යන්නේ නෑ - ඒක browsers
//      දෙක අතරේ direct (peer-to-peer) යනවා. Server එක "introduce" කරනවා විතරයි.
// -----------------------------------------------------------------------

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public folder එකේ තියෙන HTML/CSS/JS files serve කරනවා
// FIX: "public" කියලා විතරක් දුන්නොත්, node command එක project root එකෙන්
// නොවෙන තැනක ඉඳන් run කළොත් folder එක හොයාගන්න බැරි වෙන්න පුළුවන්.
// path.join(__dirname, "public") use කළොත් කොහෙන් run කළත් නිවැරදිව
// server.js එක ඉන්න තැනට relative "public" folder එක serve වෙනවා.
app.use(express.static(path.join(__dirname, "public")));

// waiting වෙන users ලා queue එක (array එකක් - filter/search කරන්න ඕන නිසා)
// එකක් = { socket, gender, lookingFor, interests }
let waitingQueue = [];

// සක්‍රීයව connect වෙලා ඉන්න pairs track කරගන්නවා
// map: socket.id -> partner socket.id
const activePairs = new Map();

// -----------------------------------------------------------
// gender preference එක check කරනවා - "any" කිව්වොත් ඕනම කෙනෙක්
// -----------------------------------------------------------
function genderMatches(myLookingFor, otherGender) {
  return myLookingFor === "any" || myLookingFor === otherGender;
}

// -----------------------------------------------------------
// දෙන්නගේම interest tags අතරේ common tags කීයක් තියෙනවද කියලා ගණන් කරනවා
// -----------------------------------------------------------
function countSharedInterests(interestsA, interestsB) {
  const setB = new Set(interestsB);
  return interestsA.filter((tag) => setB.has(tag)).length;
}

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // -----------------------------------------------------------
  // 1. "find-partner" - user "Start" click කරාම මේක fire වෙනවා
  //    profile = { gender, lookingFor, interests }
  // -----------------------------------------------------------
  socket.on("find-partner", (profile = {}) => {
    const myProfile = {
      gender: profile.gender || "unspecified",
      lookingFor: profile.lookingFor || "any",
      interests: Array.isArray(profile.interests) ? profile.interests : [],
    };

    // waiting queue එකෙන් mutual gender preference එකට ගැලපෙන candidates ලා හොයනවා
    const candidates = waitingQueue.filter((entry) => {
      if (!entry.socket.connected || entry.socket.id === socket.id) return false;
      const mutualMatch =
        genderMatches(myProfile.lookingFor, entry.gender) &&
        genderMatches(entry.lookingFor, myProfile.gender);
      return mutualMatch;
    });

    if (candidates.length > 0) {
      // Common interests වැඩිම candidate කෙනා priority කරනවා
      candidates.sort(
        (a, b) =>
          countSharedInterests(myProfile.interests, b.interests) -
          countSharedInterests(myProfile.interests, a.interests)
      );
      const match = candidates[0];

      // Match වුනු කෙනා waiting queue එකෙන් අයින් කරනවා
      waitingQueue = waitingQueue.filter((entry) => entry.socket.id !== match.socket.id);

      activePairs.set(socket.id, match.socket.id);
      activePairs.set(match.socket.id, socket.id);

      const sharedCount = countSharedInterests(myProfile.interests, match.interests);
      const sharedTags = myProfile.interests.filter((t) => match.interests.includes(t));

      // දෙන්නටම කියනවා "matched වුනා, connection පටන් ගන්න"
      socket.emit("partner-found", {
        partnerId: match.socket.id,
        initiator: true,
        sharedInterests: sharedTags,
      });
      match.socket.emit("partner-found", {
        partnerId: socket.id,
        initiator: false,
        sharedInterests: sharedTags,
      });

      console.log(
        `🔗 Paired: ${socket.id} <-> ${match.socket.id} (${sharedCount} shared interests)`
      );
    } else {
      // ගැලපෙන කෙනෙක් නෑ -> මේ user waiting queue එකට යනවා, profile එකත් සමග
      waitingQueue = waitingQueue.filter((entry) => entry.socket.id !== socket.id);
      waitingQueue.push({ socket, ...myProfile });
      socket.emit("waiting");
      console.log(`⏳ Waiting: ${socket.id} (gender: ${myProfile.gender}, looking for: ${myProfile.lookingFor})`);
    }
  });

  // -----------------------------------------------------------
  // 2. WebRTC signaling messages relay කරනවා (offer/answer/ICE)
  //    Server එක content එක බලන්නේ නෑ - partner ට pass කරනවා විතරයි
  //
  //    FIX (security): කලින් client එකෙන් එවපු "to" කෙලින්ම විශ්වාස කරලා
  //    ඕන socket id එකකට message යැව්වා - කවුරුත්ට වෙන කෙනෙක්ගේ id එකක්
  //    දාලා junk messages/video signals යවන්න පුළුවන් වුනා. දැන් server
  //    එකම activePairs බලලා "ඇත්තම partner" කවුද කියලා තීරණය කරනවා.
  // -----------------------------------------------------------
  socket.on("signal", ({ data }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("signal", { from: socket.id, data });
    }
  });

  // -----------------------------------------------------------
  // 2.5. Text chat message relay - partner ට chat message එක යවනවා
  //      FIX (security): මෙතනත් "to" client එකෙන්ම විශ්වාස කරන්නේ නැතුව
  //      activePairs එකෙන් real partner එක confirm කරනවා.
  // -----------------------------------------------------------
  socket.on("chat-message", ({ message }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("chat-message", { message });
    }
  });

  // -----------------------------------------------------------
  // 3. "Next" button - current partner එකෙන් skip කරලා අලුත් කෙනෙක්ට යනවා
  // -----------------------------------------------------------
  socket.on("next", () => {
    disconnectPair(socket.id);
  });

  // -----------------------------------------------------------
  // 4. Report button (placeholder - production එකේදි මේක database
  //    එකට log කරලා moderation team ට යවන්න ඕන)
  // -----------------------------------------------------------
  socket.on("report", ({ reason }) => {
    console.log(`🚩 Report from ${socket.id}: ${reason}`);
    // TODO: production - database එකේ save කරන්න, moderation queue එකට යවන්න
  });

  // -----------------------------------------------------------
  // 5. Disconnect handling
  // -----------------------------------------------------------
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    waitingQueue = waitingQueue.filter((entry) => entry.socket.id !== socket.id);
    disconnectPair(socket.id);
  });

  // "Next" click කරාම, හෝ Stop කරාම, waiting queue එකේ ඉඳලා තමන්වම අයින් කරගන්නවා
  socket.on("leave-queue", () => {
    waitingQueue = waitingQueue.filter((entry) => entry.socket.id !== socket.id);
  });

  function disconnectPair(id) {
    const partnerId = activePairs.get(id);
    if (partnerId) {
      io.to(partnerId).emit("partner-left");
      activePairs.delete(id);
      activePairs.delete(partnerId);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
});
