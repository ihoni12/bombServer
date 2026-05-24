const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const ROWS = 11;
const COLS = 11;

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const WAIT_TIME_MS = 30000;

let waitingPlayers = [];
let waitingTimer = null;

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
    startAt: serverNow + 3000,
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
    message: "Servidor online funcionando",
    mode: "socket.io + webrtc signaling",
  });
}

function removeFromWaiting(socketId) {
  waitingPlayers = waitingPlayers.filter((s) => s.id !== socketId);

  if (waitingPlayers.length === 0 && waitingTimer) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }
}

function startMatch(players) {
  if (players.length < MIN_PLAYERS) return;

  if (waitingTimer) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }

  waitingPlayers = waitingPlayers.filter(
    (socket) => !players.some((p) => p.id === socket.id)
  );

  const match = createMatch(players);
  const roomId = match.matchId;

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
}

function tryStartByMaxPlayers() {
  if (waitingPlayers.length >= MAX_PLAYERS) {
    const players = waitingPlayers.slice(0, MAX_PLAYERS);
    startMatch(players);
  }
}

function startWaitingTimer() {
  if (waitingTimer) return;

  waitingTimer = setTimeout(() => {
    if (waitingPlayers.length >= MIN_PLAYERS) {
      const players = waitingPlayers.slice(0, MAX_PLAYERS);
      startMatch(players);
    } else {
      waitingPlayers.forEach((socket) => {
        socket.emit("waiting-for-player", {
          playersWaiting: waitingPlayers.length,
          message: "Esperando mínimo 2 jugadores...",
        });
      });

      waitingTimer = null;
      startWaitingTimer();
    }
  }, WAIT_TIME_MS);
}

const httpServer = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);

  return sendJson(res, 404, {
    ok: false,
    error: "Ruta no encontrada. El juego usa Socket.IO.",
  });
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("want-to-play", () => {
    const alreadyWaiting = waitingPlayers.some((s) => s.id === socket.id);
    if (alreadyWaiting) return;

    waitingPlayers.push(socket);

    socket.emit("waiting-for-player", {
      playersWaiting: waitingPlayers.length,
      maxPlayers: MAX_PLAYERS,
      waitSeconds: WAIT_TIME_MS / 1000,
    });

    io.emit("waiting-room-update", {
      playersWaiting: waitingPlayers.length,
      maxPlayers: MAX_PLAYERS,
    });

    console.log(`Esperando jugadores: ${waitingPlayers.length}/${MAX_PLAYERS}`);

    tryStartByMaxPlayers();
    startWaitingTimer();
  });

  socket.on("webrtc-offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("webrtc-offer", {
      from: socket.id,
      offer,
    });
  });

  socket.on("webrtc-answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("webrtc-answer", {
      from: socket.id,
      answer,
    });
  });

  socket.on("webrtc-ice", ({ roomId, candidate }) => {
    socket.to(roomId).emit("webrtc-ice", {
      from: socket.id,
      candidate,
    });
  });

  socket.on("relay-input", ({ roomId, input }) => {
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
        socket.to(roomId).emit("peer-disconnected", {
          socketId: socket.id,
        });
      }
    }

    io.emit("waiting-room-update", {
      playersWaiting: waitingPlayers.length,
      maxPlayers: MAX_PLAYERS,
    });

    console.log("Jugador desconectado:", socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  console.log(`Prueba: http://localhost:${PORT}/health`);
});