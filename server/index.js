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

async function buildQr(socket, code) {
  const origin = socket.handshake.headers.origin || `http://${LOCAL_IP}:${PORT}`;
  const joinUrl = `${origin}/controller.html?room=${code}`;
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 });
  } catch (err) {
    console.error('QR generation failed', err);
  }
  return { joinUrl, qrDataUrl };
}

io.on('connection', (socket) => {
  socket.data.role = null;

  // Creates a brand-new room (new code, new QR). Used only the first time a
  // host picks a game for this session.
  socket.on('host:create', async (payload = {}) => {
    // Defensive cleanup: if this socket was already hosting something (e.g. a
    // page reload race), tear down the old room first rather than leaking it.
    const stale = rooms.get(socket.data.roomCode);
    if (stale && stale.hostSocketId === socket.id) {
      stale.destroy();
      rooms.delete(stale.code);
    }

    const gameType = GAME_TYPES[payload.gameType] ? payload.gameType : 'arena';
    const code = generateRoomCode();
    const room = createRoom(gameType, code, io);
    room.hostSocketId = socket.id;
    rooms.set(code, room);

    socket.join(code);
    socket.data.role = 'host';
    socket.data.roomCode = code;

    const { joinUrl, qrDataUrl } = await buildQr(socket, code);
    socket.emit('host:created', { code, joinUrl, qrDataUrl, gameType });
  });

  // Swaps the game running in the CURRENT room to a different type, keeping
  // the same room code/QR and carrying over connected players, so nobody
  // has to rescan or rejoin when the host switches games.
  socket.on('host:changeGame', (payload = {}) => {
    if (socket.data.role !== 'host') return;
    const code = socket.data.roomCode;
    const oldRoom = rooms.get(code);
    if (!oldRoom) return;

    const gameType = GAME_TYPES[payload.gameType] ? payload.gameType : 'arena';
    oldRoom.destroy();

    const newRoom = createRoom(gameType, code, io);
    newRoom.hostSocketId = socket.id;
    for (const p of oldRoom.players.values()) {
      if (p.connected) newRoom.addPlayer(p.id, p.name);
    }
    rooms.set(code, newRoom);

    io.to(code).emit('game:changed', { gameType });
    newRoom.broadcastLobby();
  });

  socket.on('player:join', ({ roomCode, name } = {}, ack) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return ack && ack({ ok: false, error: 'Room not found. Check the code and try again.' });

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
        phase: room.state, // 'lobby' | 'countdown' | 'playing' | 'ended' -- lets a late joiner drop straight into a live game
        countdownStartsAt: room.countdownStartsAt || null,
        player: {
          id: player.id,
          name: player.name,
          color: player.color,
          identityColor: player.identityColor,
          team: player.team,
        },
      });
    room.broadcastLobby();
  });

  socket.on('player:selectTeam', ({ team } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === 'player' && typeof room.setTeam === 'function') {
      room.setTeam(socket.data.playerId, team);
      room.broadcastLobby();
    }
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

  // Simple round-trip latency check. Client sends this with an ack callback;
  // replying immediately lets the client measure RTT with no clock sync needed.
  socket.on('ping:check', (_payload, ack) => {
    if (typeof ack === 'function') ack();
  });

  socket.on('player:pingReport', (ms) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.role === 'player' && typeof room.setPing === 'function') {
      room.setPing(socket.data.playerId, ms);
    }
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
  console.log('  Party Games is running!');
  console.log(`  Host screen (open on the TV/laptop): http://${LOCAL_IP}:${PORT}/host.html`);
  console.log(`  (Make sure phones join the SAME WiFi network as this computer)`);
  console.log('');
});
