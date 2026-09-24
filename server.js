// Delta Defense – Relay-Server für den Online-Koop.
// Vermittelt zwei Spieler über einen 4-stelligen Raumcode und leitet danach alle Nachrichten
// (Text und Binär) unverändert an den jeweils anderen Spieler weiter. Das Spiel selbst läuft beim Host.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne leicht verwechselbare Zeichen (0/O, 1/I)

const rooms = new Map(); // code -> { host, guest }

const server = http.createServer((req, res) => {
  // Health-Check für den Hoster
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Delta Defense Relay OK – ${rooms.size} Räume\n`);
});

const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

function newCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function leaveRoom(ws) {
  const code = ws.room;
  if (!code) return;
  const room = rooms.get(code);
  ws.room = null;
  ws.peer = null;
  if (!room) return;
  if (room.host === ws) {
    // Host geht: Raum auflösen
    rooms.delete(code);
    if (room.guest) {
      room.guest.room = null;
      room.guest.peer = null;
      send(room.guest, { t: "peer_left" });
    }
  } else if (room.guest === ws) {
    // Gast geht: Raum bleibt für den Host offen
    room.guest = null;
    room.host.peer = null;
    send(room.host, { t: "peer_left" });
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (data, isBinary) => {
    // Ausdrückliches Verlassen wird immer sofort verarbeitet (schneller als das Schließen der Verbindung)
    if (!isBinary && data.length < 32 && data.toString() === '{"t":"leave"}') {
      leaveRoom(ws);
      return;
    }
    // Verbundene Spieler: alles an den Partner weiterleiten
    if (ws.peer) {
      if (ws.peer.readyState === 1) ws.peer.send(data, { binary: isBinary });
      return;
    }
    if (isBinary) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.t === "create") {
      leaveRoom(ws);
      const code = newCode();
      rooms.set(code, { host: ws, guest: null });
      ws.room = code;
      send(ws, { t: "created", code });
    } else if (msg.t === "join") {
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", msg: "Raum nicht gefunden" });
      if (room.guest) return send(ws, { t: "error", msg: "Raum ist schon voll" });
      if (room.host === ws) return send(ws, { t: "error", msg: "Das ist dein eigener Raum" });
      leaveRoom(ws);
      room.guest = ws;
      ws.room = code;
      ws.peer = room.host;
      room.host.peer = ws;
      send(ws, { t: "joined", code });
      send(room.host, { t: "peer_joined" });
    } else if (msg.t === "leave") {
      leaveRoom(ws);
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => {});
});

// Tote Verbindungen aufräumen (alle 10 s)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

server.listen(PORT, () => console.log(`Relay läuft auf Port ${PORT}`));
