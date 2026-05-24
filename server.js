const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const ROWS = 11;
const COLS = 11;

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const WAIT_TIME_MS = 30000;
const START_DELAY_MS = 3000;

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

  if (roll < 45) return "vacio";
  if (roll < 58) return "life";
  if (roll < 68) return "range";
  if (roll < 76) return "speed";
  if (roll < 84) return "bulletDamage";
  if (roll < 91) return "bomb";
  if (roll < 96) return "shield100";
  if (roll < 98) return "shield5";
  if (roll < 99) return "pushBomb";
  if (roll < 99.6) return "fiveShots";
  return "playerShot";
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
  }));
}

function createMatch(sockets) {
  const serverNow = Date.now();

  return {
    matchId: crypto.randomUUID(),
    serverNow,
    startAt: serverNow + START_DELAY_MS,
    playersCount: sockets.length,
    playersByCorner: buildCornerPlayers(sockets),
    boxContents: createBoxContents(),
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

function getWaitingPayload(extra = {}) {
  const now = Date.now();
  const autoStartAt = lastPlayerJoinedAt ? lastPlayerJoinedAt + WAIT_TIME_MS : null;
  const remainingMs = autoStartAt ? Math.max(0, autoStartAt - now) : WAIT_TIME_MS;

  return {
    playersWaiting: waitingPlayers.length,
    playersCount: waitingPlayers.length,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    waitSeconds: WAIT_TIME_MS / 1000,
    waitingStartedAt,
    lastPlayerJoinedAt,
    autoStartAt,
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    message:
      waitingPlayers.length >= MIN_PLAYERS
        ? "Hay suficientes jugadores. Si no entra nadie más, la partida empieza en breve."
        : "Esperando al menos 2 jugadores para comenzar.",
    ...extra,
  };
}

function emitWaitingRoomUpdate(extra = {}) {
  io.emit("waiting-room-update", getWaitingPayload(extra));
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
  const before = waitingPlayers.length;
  waitingPlayers = waitingPlayers.filter((s) => s.id !== socketId);

  if (before !== waitingPlayers.length) {
    clearWaitingTimerIfNeeded();
    emitWaitingRoomUpdate();
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

function tryStartByMaxPlayers() {
  if (waitingPlayers.length >= MAX_PLAYERS) {
    const players = waitingPlayers.slice(0, MAX_PLAYERS);
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

    if (waitingPlayers.length >= MIN_PLAYERS) {
      const players = waitingPlayers.slice(0, MAX_PLAYERS);
      startMatch(players);
      return;
    }

    waitingPlayers.forEach((socket) => {
      socket.emit("waiting-for-player", getWaitingPayload());
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
});

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("want-to-play", () => {
    const alreadyWaiting = waitingPlayers.some((s) => s.id === socket.id);
    if (alreadyWaiting) {
      socket.emit("waiting-for-player", getWaitingPayload());
      return;
    }

    waitingPlayers.push(socket);
    if (!waitingStartedAt) waitingStartedAt = Date.now();
    lastPlayerJoinedAt = Date.now();

    socket.emit("waiting-for-player", getWaitingPayload({
      message: "Entraste a la sala de espera. Buscando jugadores...",
    }));

    emitWaitingRoomUpdate();
    console.log(`Sala de espera: ${waitingPlayers.length}/${MAX_PLAYERS}`);

    if (waitingPlayers.length >= MAX_PLAYERS) {
      tryStartByMaxPlayers();
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

  socket.on("relay-input", ({ roomId, input }) => {
    if (!roomId || !input) return;
    socket.to(roomId).emit("relay-input", { input });
  });

  socket.on("relay-game-message", ({ roomId, message }) => {
    if (!roomId || !message) return;
    socket.to(roomId).emit("relay-game-message", { message });
  });

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
