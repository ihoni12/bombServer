/*
ÍNDICE DE FUNCIONES - SERVIDOR ONLINE (server/server.js)
01. canHaveBox: revisa si una celda puede tener caja.
02. chooseRandomBoxContent: decide qué premio tiene una caja.
03. createBoxContents: crea el array 2D random de cajas y premios.
04. buildCornerPlayers: arma jugadores por esquina.
05. createMatch: crea partida de 2 jugadores con cajas ya generadas.
06. sendJson: responde JSON y agrega CORS.
07. handleHealth: prueba si el servidor funciona.
08. socket connection: empareja jugadores, manda configuración y hace signaling WebRTC.
*/

const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const ROWS = 11;
const COLS = 11;

let waitingSocket = null;

// FUNCIÓN 01: revisa si una celda puede tener caja rompible.
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

// FUNCIÓN 02: decide aleatoriamente qué tiene una caja por dentro.
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

// FUNCIÓN 03: crea las cajas random UNA SOLA VEZ en el servidor.
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

// FUNCIÓN 04: arma jugadores por esquina. Para probar online lo dejé en 2 jugadores.
function buildCornerPlayers(sockets) {
  return sockets.map((socket, index) => ({
    corner: index,
    socketId: socket.id,
    peerId: socket.id,
  }));
}

// FUNCIÓN 05: crea partida de 2 jugadores con la MISMA info para ambos.
function createMatch(sockets) {
  const serverNow = Date.now();
  return {
    matchId: crypto.randomUUID(),
    serverNow,
    startAt: serverNow + 3000,
    playersByCorner: buildCornerPlayers(sockets),
    boxContents: createBoxContents(),
  };
}

// FUNCIÓN 06: responde JSON simple.
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// FUNCIÓN 07: health check.
function handleHealth(req, res) {
  sendJson(res, 200, { ok: true, message: "Servidor online funcionando", mode: "socket.io + webrtc signaling" });
}

const httpServer = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);
  return sendJson(res, 404, { ok: false, error: "Ruta no encontrada. El juego usa Socket.IO." });
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// FUNCIÓN 08: Socket.IO empareja, manda cajas y pasa mensajes WebRTC.
io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("want-to-play", () => {
    if (waitingSocket && waitingSocket.connected && waitingSocket.id !== socket.id) {
      const playerA = waitingSocket;
      const playerB = socket;
      waitingSocket = null;

      const match = createMatch([playerA, playerB]);
      const roomId = match.matchId;

      playerA.join(roomId);
      playerB.join(roomId);

      playerA.emit("match-found", { ...match, roomId, localCorner: 0, shouldCreateOffer: true });
      playerB.emit("match-found", { ...match, roomId, localCorner: 1, shouldCreateOffer: false });

      console.log("Partida creada:", roomId);
    } else {
      waitingSocket = socket;
      socket.emit("waiting-for-player");
      console.log("Esperando otro jugador...");
    }
  });

  // Estos eventos NO son lógica del juego. Solo ayudan a abrir el canal P2P.
  socket.on("webrtc-offer", ({ roomId, offer }) => socket.to(roomId).emit("webrtc-offer", { offer }));
  socket.on("webrtc-answer", ({ roomId, answer }) => socket.to(roomId).emit("webrtc-answer", { answer }));
  socket.on("webrtc-ice", ({ roomId, candidate }) => socket.to(roomId).emit("webrtc-ice", { candidate }));

  // Fallback: si WebRTC falla, igual podemos reenviar inputs por el servidor.
  socket.on("relay-input", ({ roomId, input }) => socket.to(roomId).emit("relay-input", { input }));

  // Mensajes de sincronización de estado: request/response para reconectar o recuperar partida.
  socket.on("relay-game-message", ({ roomId, message }) => {
    if (!roomId || !message) return;
    socket.to(roomId).emit("relay-game-message", { message });
  });

  socket.on("disconnect", () => {
    if (waitingSocket?.id === socket.id) waitingSocket = null;
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) socket.to(roomId).emit("peer-disconnected");
    }
    console.log("Jugador desconectado:", socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
  console.log(`Prueba: http://localhost:${PORT}/health`);
});
