require('dotenv').config();

const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { createRoom, GAME_TYPES } = require('./roomFactory');

const app = express();
const server = http.createServer(app);

// Only needed if the frontend is ever hosted on a different origin than this
// server (an advanced/rare setup) — leave CORS_ORIGIN unset for the normal
// setup where this same server also serves the static files.
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : undefined;

const io = new Server(server, {
  // These were tuned tight (2s/5s) for LAN-only use, where near-zero latency
  // meant fast disconnect detection with no downside. Over a real internet
  // connection (as on a cloud host), a brief blip can exceed 5s easily —
  // and when the HOST's socket gets marked disconnected, the room used to
  // be destroyed immediately, silently invalidating the QR code/room code
  // still shown on screen. More tolerant, closer-to-standard values here.
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: CORS_ORIGIN ? { origin: CORS_ORIGIN, methods: ['GET', 'POST'] } : undefined,
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// There's no public/index.html, so visiting the bare domain 404s unless we
// redirect it somewhere useful.
app.get('/', (req, res) => res.redirect('/host.html'));

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
  // Priority: explicit env override (needed on most cloud hosts, since a
  // platform's reverse proxy doesn't always forward a reliable Origin header)
  // -> the browser's own request origin (works great for local LAN use)
  // -> last-resort LAN IP guess.
  const origin = process.env.PUBLIC_BASE_URL || socket.handshake.headers.origin || `http://${LOCAL_IP}:${PORT}`;
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
    const room = createRoom(gameType, code, io, { arenaSize: payload.arenaSize });
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

    const newRoom = createRoom(gameType, code, io, { arenaSize: payload.arenaSize });
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

  // Lets a host's browser recover the SAME room (same code/QR) after a
  // reconnect, instead of the room having been destroyed while it was
  // briefly disconnected.
  socket.on('host:reclaim', ({ code } = {}, ack) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return ack && ack({ ok: false });
    clearTimeout(room.hostGraceTimer);
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    ack && ack({ ok: true, gameType: room.gameType, phase: room.state });
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

  // A brief host disconnect (WiFi blip, laptop sleep, tab backgrounding,
  // Fly's proxy recycling an idle connection) is common on a real internet
  // connection and should NOT silently invalidate the QR code/room code
  // still shown on screen. Give the host a window to reconnect and reclaim
  // the same room before actually tearing it down.
  const HOST_RECONNECT_GRACE_MS = 45000;

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.role === 'host') {
      if (room.hostSocketId !== socket.id) return; // a newer host connection already replaced this one
      room.hostSocketId = null;
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = setTimeout(() => {
        if (room.hostSocketId === null) {
          room.destroy();
          rooms.delete(room.code);
        }
      }, HOST_RECONNECT_GRACE_MS);
    } else if (socket.data.role === 'player') {
      room.removePlayer(socket.data.playerId);
      room.broadcastLobby();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const publicUrl = process.env.PUBLIC_BASE_URL || `http://${LOCAL_IP}:${PORT}`;
  console.log('');
  console.log('  Party Games is running!');
  console.log(`  Host screen: ${publicUrl}/  (redirects to /host.html)`);
  if (!process.env.PUBLIC_BASE_URL) {
    console.log('  (Make sure phones join the SAME WiFi network as this computer)');
  }
  console.log('');
});
