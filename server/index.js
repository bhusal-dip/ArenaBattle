const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { createRoom, GAME_TYPES } = require('./roomFactory');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 2000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map(); // code -> Room
const PORT = process.env.PORT || 3000;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();

io.on('connection', (socket) => {
  socket.data.role = null;

  socket.on('host:create', async (payload = {}) => {
    const gameType = GAME_TYPES[payload.gameType] ? payload.gameType : 'arena';
    // const code = generateRoomCode();
    const code = "JLSV"; // Hardcoded room code for testing
    const room = createRoom(gameType, code, io);
    room.hostSocketId = socket.id;
    rooms.set(code, room);

    socket.join(code);
    socket.data.role = 'host';
    socket.data.roomCode = code;

    // Use the browser's own origin (works for LAN IP, localhost, or a real
    // domain if this is deployed) rather than a hardcoded local IP.
    const origin = socket.handshake.headers.origin || `http://${LOCAL_IP}:${PORT}`;
    const joinUrl = `${origin}/controller.html?room=${code}`;
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 });
    } catch (err) {
      console.error('QR generation failed', err);
    }

    socket.emit('host:created', { code, joinUrl, qrDataUrl, gameType });
  });

  socket.on('player:join', ({ roomCode, name } = {}, ack) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return ack && ack({ ok: false, error: 'Room not found. Check the code and try again.' });
    if (room.state !== 'lobby') return ack && ack({ ok: false, error: 'Game already in progress. Wait for next round.' });

    const player = room.addPlayer(socket.id, name);
    if (!player) return ack && ack({ ok: false, error: 'Room is full (max 10 players).' });

    socket.join(room.code);
    socket.data.role = 'player';
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;

    ack &&
      ack({
        ok: true,
        gameType: room.gameType,
        player: { id: player.id, name: player.name, color: player.color, team: player.team },
      });
    room.broadcastLobby();
  });

  socket.on('host:start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === 'host') room.startGame();
  });

  socket.on('host:restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === 'host') room.resetToLobby();
  });

  socket.on('player:input', (input) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === 'player') room.setInput(socket.data.playerId, input || {});
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.role === 'host') {
      room.destroy();
      rooms.delete(room.code);
    } else if (socket.data.role === 'player') {
      room.removePlayer(socket.data.playerId);
      room.broadcastLobby();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Arena Battle is running!');
  console.log(`  Host screen (open on the TV/laptop): http://${LOCAL_IP}:${PORT}/host.html`);
  console.log(`  (Make sure phones join the SAME WiFi network as this computer)`);
  console.log('');
});
