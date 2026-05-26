const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const ROWS = 11;
const COLS = 11;

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const WAIT_TIME_MS = 3000;
const START_DELAY_MS = 3000;


function normalizeProfile(profile = {}) {
  const name = String(profile.name || "Jugador").trim().slice(0, 18) || "Jugador";
  const photo = typeof profile.photo === "string" && profile.photo.startsWith("data:image/")
    ? profile.photo.slice(0, 350000)
    : "";
  const cleanSelectedSkins = (profile.stats?.selectedSkins && typeof profile.stats.selectedSkins === "object")
    ? {
        player: String(profile.stats.selectedSkins.player || "classic").slice(0, 24),
        bomb: String(profile.stats.selectedSkins.bomb || "classic").slice(0, 24),
        bullet: String(profile.stats.selectedSkins.bullet || "classic").slice(0, 24),
        gun: String(profile.stats.selectedSkins.gun || "classic").slice(0, 24),
      }
    : { player: "classic", bomb: "classic", bullet: "classic", gun: "classic" };

  const stats = profile.stats && typeof profile.stats === "object"
    ? {
        level: Math.max(1, Number(profile.stats.level || 1)),
        wins: Math.max(0, Number(profile.stats.wins || 0)),
        kills: Math.max(0, Number(profile.stats.kills || 0)),
        matches: Math.max(0, Number(profile.stats.matches || 0)),
        selectedSkins: cleanSelectedSkins,
      }
    : { level: 1, wins: 0, kills: 0, matches: 0, selectedSkins: cleanSelectedSkins };

  return { name, photo, stats };
}

function normalizeRoomCode(roomCode = "") {
  const clean = String(roomCode || "PUBLIC").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
  return clean || "PUBLIC";
}

function publicWaitingPlayers(roomCode = null) {
  return waitingPlayers
    .filter((socket) => !roomCode || socket.roomCode === roomCode)
    .map((socket) => ({
      socketId: socket.id,
      profile: normalizeProfile(socket.playerProfile),
      roomCode: socket.roomCode || "PUBLIC",
    }));
}

let waitingPlayers = [];
let waitingTimer = null;
let waitingStartedAt = null;
let lastPlayerJoinedAt = null;

function canHaveBox(x, y) {
  const isBorder = x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1;
  const isFixedWall = x % 2 === 0 && y % 2 === 0;
  const spawnSafe =
    (x <= 2 && y <= 2) ||
    (x >= 8 && y <= 2) ||
    (x <= 2 && y >= 8) ||
    (x >= 8 && y >= 8);

  return !isBorder && !isFixedWall && !spawnSafe;
}

function chooseRandomBoxContent() {
  const roll = Math.random() * 100;

 if (roll < 40) return "vacio";

// 25%
if (roll < 46.25) return "bomb";
if (roll < 52.5) return "bulletDamage";
if (roll < 58.75) return "speed";
if (roll < 65) return "life";

// 20%
if (roll < 70) return "shield5";
if (roll < 75) return "shield100";
if (roll < 80) return "range";
if (roll < 85) return "pushBomb";

// 14%
if (roll < 92) return "playerShot";
if (roll < 99) return "fiveShots";

// 1%
return "nuke";
}

function createBoxContents() {
  const boxContents = [];

  for (let y = 0; y < ROWS; y++) {
    const row = [];

    for (let x = 0; x < COLS; x++) {
      if (!canHaveBox(x, y)) {
        row.push("nada");
        continue;
      }

      const hasBox = Math.random() < 0.68;
      row.push(hasBox ? chooseRandomBoxContent() : "nada");
    }

    boxContents.push(row);
  }

  return boxContents;
}

function buildCornerPlayers(sockets) {
  return sockets.map((socket, index) => ({
    corner: index,
    socketId: socket.id,
    peerId: socket.id,
    profile: normalizeProfile(socket.playerProfile),
  }));
}

function createMatch(sockets) {
  const serverNow = Date.now();
  const matchSeed = crypto.randomBytes(8).toString("hex");

  // El servidor SOLO crea la sala, el seed inicial y la info básica.
  // NO recibe ni reenvía movimiento, bombas, balas, vida, skins durante la partida.
  // Después de match-found, el juego viaja por WebRTC DataChannel entre usuarios.
  return {
    matchId: crypto.randomUUID(),
    serverNow,
    startAt: serverNow + START_DELAY_MS,
    playersCount: sockets.length,
    playersByCorner: buildCornerPlayers(sockets),
    matchSeed,
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  res.end(JSON.stringify(data));
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    message: "Servidor online funcionando correctamente.",
    mode: "Socket.IO + WebRTC signaling",
    waitingPlayers: waitingPlayers.length,
    lastPlayerJoinedAt,
    autoStartAt: lastPlayerJoinedAt ? lastPlayerJoinedAt + WAIT_TIME_MS : null,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
  });
}

function getWaitingPayload(extra = {}, roomCode = "PUBLIC") {
  const now = Date.now();
  const autoStartAt = lastPlayerJoinedAt ? lastPlayerJoinedAt + WAIT_TIME_MS : null;
  const remainingMs = autoStartAt ? Math.max(0, autoStartAt - now) : WAIT_TIME_MS;

  const playersInRoom = waitingPlayers.filter((socket) => socket.roomCode === roomCode);

  return {
    roomCode,
    playersWaiting: playersInRoom.length,
    playersCount: playersInRoom.length,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    waitSeconds: WAIT_TIME_MS / 1000,
    waitingStartedAt,
    lastPlayerJoinedAt,
    autoStartAt,
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    players: publicWaitingPlayers(roomCode),
    message:
      playersInRoom.length >= MIN_PLAYERS
        ? "Hay suficientes jugadores. Si no entra nadie más, la partida empieza en breve."
        : "Esperando al menos 2 jugadores para comenzar.",
    ...extra,
  };
}

function emitWaitingRoomUpdate(extra = {}, roomCode = null) {
  const rooms = roomCode ? [roomCode] : [...new Set(waitingPlayers.map((s) => s.roomCode || "PUBLIC"))];
  for (const code of rooms) {
    for (const socket of waitingPlayers.filter((s) => (s.roomCode || "PUBLIC") === code)) {
      socket.emit("waiting-room-update", getWaitingPayload(extra, code));
    }
  }
}

function clearWaitingTimerIfNeeded() {
  if (waitingPlayers.length === 0) {
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = null;
    waitingStartedAt = null;
    lastPlayerJoinedAt = null;
  }
}

function removeFromWaiting(socketId) {
  const socket = waitingPlayers.find((s) => s.id === socketId);
  const roomCode = socket?.roomCode || "PUBLIC";
  const before = waitingPlayers.length;
  waitingPlayers = waitingPlayers.filter((s) => s.id !== socketId);

  if (before !== waitingPlayers.length) {
    clearWaitingTimerIfNeeded();
    emitWaitingRoomUpdate({}, roomCode);
  }
}

function startMatch(players) {
  if (players.length < MIN_PLAYERS) return;

  if (waitingTimer) clearTimeout(waitingTimer);
  waitingTimer = null;

  waitingPlayers = waitingPlayers.filter(
    (socket) => !players.some((p) => p.id === socket.id)
  );

  const match = createMatch(players);
  const roomId = match.matchId;

  players.forEach((player) => {
    player.emit("match-starting", {
      roomId,
      playersCount: players.length,
      maxPlayers: MAX_PLAYERS,
      startAt: match.startAt,
      message: "Partida encontrada. Preparando el inicio...",
    });
  });

  players.forEach((player, index) => {
    player.join(roomId);

    player.emit("match-found", {
      ...match,
      roomId,
      localCorner: index,
      shouldCreateOffer: index === 0,
    });
  });

  console.log(`Partida creada: ${roomId} con ${players.length} jugadores`);

  if (waitingPlayers.length > 0) {
    waitingStartedAt = Date.now();
    lastPlayerJoinedAt = Date.now();
    emitWaitingRoomUpdate();
    resetWaitingTimer();
  } else {
    waitingStartedAt = null;
    lastPlayerJoinedAt = null;
  }
}

function tryStartByMaxPlayers(roomCode = "PUBLIC") {
  const playersInRoom = waitingPlayers.filter((s) => s.roomCode === roomCode);
  if (playersInRoom.length >= MAX_PLAYERS) {
    const players = playersInRoom.slice(0, MAX_PLAYERS);
    startMatch(players);
  }
}

function resetWaitingTimer() {
  if (waitingTimer) clearTimeout(waitingTimer);
  waitingTimer = null;
  startWaitingTimer();
}

function startWaitingTimer() {
  if (waitingTimer || waitingPlayers.length === 0) return;
  if (!waitingStartedAt) waitingStartedAt = Date.now();
  if (!lastPlayerJoinedAt) lastPlayerJoinedAt = Date.now();

  const delay = Math.max(0, lastPlayerJoinedAt + WAIT_TIME_MS - Date.now());

  waitingTimer = setTimeout(() => {
    waitingTimer = null;

    // Agrupamos por sala. Antes acá decía `playersInRoom`,
    // pero esa variable no existía dentro de esta función y rompía el server.
    const roomCodes = [...new Set(waitingPlayers.map((socket) => socket.roomCode || "PUBLIC"))];

    for (const code of roomCodes) {
      const playersInRoom = waitingPlayers.filter((socket) => (socket.roomCode || "PUBLIC") === code);

      if (playersInRoom.length >= MAX_PLAYERS) {
        startMatch(playersInRoom.slice(0, MAX_PLAYERS));
        return;
      }

      if (playersInRoom.length >= MIN_PLAYERS) {
        startMatch(playersInRoom.slice(0, MAX_PLAYERS));
        return;
      }
    }

    waitingPlayers.forEach((socket) => {
      socket.emit("waiting-for-player", getWaitingPayload({}, socket.roomCode || "PUBLIC"));
    });

    emitWaitingRoomUpdate();
    startWaitingTimer();
  }, delay);
}

const httpServer = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);

  return sendJson(res, 404, {
    ok: false,
    error: "Ruta no encontrada. Este juego usa Socket.IO para las partidas online.",
  });
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 2e6,
});

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("want-to-play", (data = {}) => {
    socket.playerProfile = normalizeProfile(data.profile);
    socket.roomCode = normalizeRoomCode(data.roomCode);
    const alreadyWaiting = waitingPlayers.some((s) => s.id === socket.id);
    if (alreadyWaiting) {
      socket.emit("waiting-for-player", getWaitingPayload({}, socket.roomCode));
      return;
    }

    waitingPlayers.push(socket);
    if (!waitingStartedAt) waitingStartedAt = Date.now();
    lastPlayerJoinedAt = Date.now();

    socket.emit("waiting-for-player", getWaitingPayload({
      message: "Entraste a la sala de espera. Buscando jugadores...",
    }, socket.roomCode));

    emitWaitingRoomUpdate({}, socket.roomCode);
    console.log(`Sala de espera: ${waitingPlayers.length}/${MAX_PLAYERS}`);

    if (waitingPlayers.filter((s) => s.roomCode === socket.roomCode).length >= MAX_PLAYERS) {
      tryStartByMaxPlayers(socket.roomCode);
    } else {
      resetWaitingTimer();
    }
  });

  socket.on("cancel-waiting", () => {
    removeFromWaiting(socket.id);
    socket.emit("waiting-cancelled", {
      ok: true,
      message: "Saliste de la sala de espera.",
    });
  });

  socket.on("webrtc-offer", ({ roomId, offer }) => {
    if (!roomId || !offer) return;
    socket.to(roomId).emit("webrtc-offer", { from: socket.id, offer });
  });

  socket.on("webrtc-answer", ({ roomId, answer }) => {
    if (!roomId || !answer) return;
    socket.to(roomId).emit("webrtc-answer", { from: socket.id, answer });
  });

  socket.on("webrtc-ice", ({ roomId, candidate }) => {
    if (!roomId || !candidate) return;
    socket.to(roomId).emit("webrtc-ice", { from: socket.id, candidate });
  });

  // Seguridad/claridad: aunque un cliente viejo intente mandar datos del juego
  // por Socket.IO, el servidor NO los reenvía. La partida va solo P2P.
  socket.on("game-input", () => {});
  socket.on("game-state", () => {});
  socket.on("state-request", () => {});
  socket.on("state-response", () => {});

  socket.on("disconnect", () => {
    removeFromWaiting(socket.id);

    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("peer-disconnected", { socketId: socket.id });
      }
    }

    console.log("Jugador desconectado:", socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  console.log(`Prueba: http://localhost:${PORT}/health`);
});
