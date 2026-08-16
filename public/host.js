const socket = io();

const selectScreen = document.getElementById('select-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const countdownScreen = document.getElementById('countdown-screen');
const gameScreen = document.getElementById('game-screen');
const endScreen = document.getElementById('end-screen');

const lobbyTitle = document.getElementById('lobby-title');
const qrImg = document.getElementById('qr-img');
const roomCodeText = document.getElementById('room-code-text');
const joinUrlText = document.getElementById('join-url-text');
const playerCountEl = document.getElementById('player-count');
const playerListEl = document.getElementById('player-list');
const startBtn = document.getElementById('start-btn');
const countdownNumber = document.getElementById('countdown-number');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const hpBarsEl = document.getElementById('hp-bars');
const scoreHud = document.getElementById('score-hud');
const scoreRedEl = document.getElementById('score-red');
const scoreBlueEl = document.getElementById('score-blue');
const matchClockEl = document.getElementById('match-clock');
const winnerNameEl = document.getElementById('winner-name');
const restartBtn = document.getElementById('restart-btn');
const changeGameBtn = document.getElementById('change-game-btn');
const announcementsEl = document.getElementById('announcements');
const codeBadge = document.getElementById('code-badge');
const codeBadgeQr = document.getElementById('code-badge-qr');
const codeBadgeCode = document.getElementById('code-badge-code');
const goalLogEl = document.getElementById('goal-log');
const confettiLayer = document.getElementById('confetti-layer');

const GAME_LABELS = { arena: 'Arena Battle', hockey: 'Puck Rush' };
const RENDER_SCALE = 1.35; // zoom factor for the shared display, purely visual
const HIGH_PING_MS = 200; // above this, flag the player on-screen as having a connection issue

let currentGameType = 'arena';
let hasCreatedRoom = false; // true once a room exists; further game picks reuse the same room/code

function showScreen(el) {
  [selectScreen, lobbyScreen, countdownScreen, gameScreen, endScreen].forEach((s) => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function applyGameTypeChrome(gameType) {
  currentGameType = gameType;
  lobbyTitle.innerHTML = `${GAME_LABELS[gameType].toUpperCase()} <span>LOBBY</span>`;
  scoreHud.classList.toggle('hidden', gameType !== 'hockey');
  hpBarsEl.classList.toggle('hidden', gameType !== 'arena');
  goalLogEl.classList.toggle('hidden', gameType !== 'hockey');
}

function updateCodeBadge(code, qrDataUrl) {
  codeBadgeCode.textContent = code;
  if (qrDataUrl) codeBadgeQr.src = qrDataUrl;
  codeBadge.classList.remove('hidden');
}

// ---- Sound (synthesized, no audio files needed — works with zero internet on-site) ----
let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone({ freq, duration = 0.15, type = 'sine', gain = 0.2, delay = 0, glideTo = null }) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function playHitSound() { playTone({ freq: 220, glideTo: 90, duration: 0.12, type: 'sawtooth', gain: 0.18 }); }
function playEliminationSound() { playTone({ freq: 520, glideTo: 140, duration: 0.5, type: 'square', gain: 0.16 }); }
function playGoalSound() {
  [440, 660, 880].forEach((freq, i) => playTone({ freq, duration: 0.28, type: 'triangle', gain: 0.2, delay: i * 0.08 }));
}
function playWinSound() {
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) =>
    playTone({ freq, duration: 0.35, type: 'triangle', gain: 0.18, delay: i * 0.12 })
  );
}

function showAnnouncement(text, color) {
  const el = document.createElement('div');
  el.className = 'announce-banner';
  el.textContent = text;
  if (color) el.style.color = color;
  announcementsEl.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Game selection ----
// The very first pick creates a fresh room (new code/QR). Every pick after
// that reuses host:changeGame, which keeps the SAME room code so already-
// connected players never have to rescan or rejoin.
document.querySelectorAll('.game-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    unlockAudio(); // arm audio here too, in case Start is clicked quickly after
    const gameType = btn.dataset.game;
    applyGameTypeChrome(gameType);
    if (!hasCreatedRoom) {
      socket.emit('host:create', { gameType });
    } else {
      socket.emit('host:changeGame', { gameType });
    }
  });
});

socket.on('host:created', ({ code, joinUrl, qrDataUrl, gameType }) => {
  hasCreatedRoom = true;
  applyGameTypeChrome(gameType);
  roomCodeText.textContent = code;
  joinUrlText.textContent = joinUrl;
  if (qrDataUrl) qrImg.src = qrDataUrl;
  updateCodeBadge(code, qrDataUrl);
  showScreen(lobbyScreen);
});

// Game type swapped in place — same code/QR, just refresh the lobby chrome.
socket.on('game:changed', ({ gameType }) => {
  applyGameTypeChrome(gameType);
  showScreen(lobbyScreen);
});

socket.on('lobby:update', ({ players }) => {
  playerCountEl.textContent = players.length;
  playerListEl.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    const dotColor = p.identityColor || p.color;
    const teamBadge = p.team
      ? `<span class="team-badge team-badge-${p.team}">${p.team === 'red' ? 'R' : 'B'}</span>`
      : '';
    const pingTag = typeof p.pingMs === 'number' ? `<span class="ping-tag">${p.pingMs}ms</span>` : '';
    li.innerHTML = `<span class="dot" style="background:${dotColor}"></span>${teamBadge}${p.name}${pingTag}`;
    if (!p.connected) li.style.opacity = '0.4';
    playerListEl.appendChild(li);
  });
  startBtn.disabled = players.length < 2;
  startBtn.textContent = players.length < 2 ? 'Need at least 2 players…' : `Start Game (${players.length} players)`;
});

startBtn.addEventListener('click', () => {
  unlockAudio(); // must happen on a user gesture for sound to be allowed
  socket.emit('host:start');
});

// Same room, same game, fresh round — players stay connected the whole time.
restartBtn.addEventListener('click', () => {
  confettiLayer.innerHTML = '';
  showScreen(lobbyScreen);
  socket.emit('host:restart');
});

// Same room, different game — connected players get moved over automatically.
changeGameBtn.addEventListener('click', () => {
  confettiLayer.innerHTML = '';
  showScreen(selectScreen);
});

socket.on('game:countdown', ({ startsAt }) => {
  showScreen(countdownScreen);
  const tick = () => {
    const remaining = Math.ceil((startsAt - Date.now()) / 1000);
    if (remaining <= 0) {
      countdownNumber.textContent = 'GO!';
      resizeCanvas();
      showScreen(gameScreen);
      return;
    }
    countdownNumber.textContent = remaining;
    requestAnimationFrame(tick);
  };
  tick();
});

let latestState = null;
socket.on('state:update', (state) => {
  latestState = state;
  if (state.gameType === 'hockey') {
    scoreRedEl.textContent = state.score.red;
    scoreBlueEl.textContent = state.score.blue;
    const secs = Math.ceil(state.timeRemaining / 1000);
    matchClockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    renderGoalLog(state.players);
  }
});

function renderGoalLog(players) {
  const scorers = players.filter((p) => p.goals > 0 || p.ownGoals > 0);
  goalLogEl.innerHTML = scorers
    .map((p) => {
      const parts = [];
      if (p.goals > 0) parts.push(`×${p.goals}`);
      if (p.ownGoals > 0) parts.push(`OG ×${p.ownGoals}`);
      const cls = p.ownGoals > 0 && p.goals === 0 ? 'goal-chip own-goal' : 'goal-chip';
      return `<span class="${cls}"><span class="dot" style="background:${p.identityColor || p.color}"></span>${p.name} ${parts.join(' ')}</span>`;
    })
    .join('');
}

socket.on('fx:hit', () => playHitSound());
socket.on('fx:steal', () => playHitSound());

socket.on('player:eliminated', ({ name, color, placement }) => {
  playEliminationSound();
  showAnnouncement(`${name} eliminated — ${ordinal(placement)} place`, color);
});

socket.on('goal:scored', ({ team, scorerName, scorerColor, ownGoal }) => {
  playGoalSound();
  const teamColor = team === 'red' ? '#e63946' : '#4cc9f0';
  if (ownGoal && scorerName) {
    showAnnouncement(`OWN GOAL! ${scorerName} — ${team.toUpperCase()} benefits`, '#ffb4b4');
  } else if (scorerName) {
    showAnnouncement(`GOAL! ${scorerName} scores for ${team.toUpperCase()}`, scorerColor || teamColor);
  } else {
    showAnnouncement(`GOAL! ${team.toUpperCase()} scores`, teamColor);
  }
});

socket.on('game:ended', (payload) => {
  playWinSound();
  if (payload.mode === 'hockey') {
    const { winnerTeam, score } = payload;
    if (winnerTeam) {
      winnerNameEl.textContent = `${winnerTeam.toUpperCase()} WINS ${score.red}–${score.blue}`;
      winnerNameEl.style.color = winnerTeam === 'red' ? '#e63946' : '#4cc9f0';
      launchConfetti(winnerTeam === 'red' ? ['#e63946', '#ff595e', '#ffca3a'] : ['#4cc9f0', '#4361ee', '#8ac926']);
    } else {
      winnerNameEl.textContent = `DRAW ${score.red}–${score.blue}`;
      winnerNameEl.style.color = '#fff';
    }
  } else {
    const { winner } = payload;
    winnerNameEl.textContent = winner ? winner.name : 'No one (draw)';
    winnerNameEl.style.color = winner ? winner.color : '#fff';
    if (winner) launchConfetti([winner.color, '#ffca3a', '#8ac926', '#4cc9f0']);
  }
  showScreen(endScreen);
});

function launchConfetti(colors) {
  confettiLayer.innerHTML = '';
  const pieceCount = 80;
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    confettiLayer.appendChild(piece);
  }
  setTimeout(() => {
    confettiLayer.innerHTML = '';
  }, 4500);
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (!latestState || gameScreen.classList.contains('hidden')) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (latestState.gameType === 'hockey') renderHockey(latestState);
  else renderArena(latestState);
}
requestAnimationFrame(renderLoop);

// Draws a small "⚠ 240ms" tag under a player's name label, only when their
// latency is high enough to actually be worth flagging as a possible issue.
function drawPingWarning(x, y, pingMs) {
  if (typeof pingMs !== 'number' || pingMs < HIGH_PING_MS) return;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#ff595e';
  ctx.textAlign = 'center';
  ctx.fillText(`⚠ ${pingMs}ms`, x, y + 34);
}

function renderArena(state) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const S = RENDER_SCALE;

  ctx.beginPath();
  ctx.arc(cx, cy, state.arenaR * S, 0, Math.PI * 2);
  ctx.strokeStyle = '#4cc9f0';
  ctx.lineWidth = 4;
  ctx.shadowColor = '#4cc9f0';
  ctx.shadowBlur = 20;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(76,201,240,0.05)';
  ctx.fill();

  state.players.forEach((p) => {
    if (!p.alive) return;
    const x = cx + p.x * S;
    const y = cy + p.y * S;
    ctx.beginPath();
    ctx.arc(x, y, 18 * S, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    if (p.dashing) { ctx.shadowColor = p.color; ctx.shadowBlur = 25; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = p.identityColor || '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 26 * S);
    drawPingWarning(x, y, p.pingMs);
  });

  renderHpBars(state.players);
}

function renderHpBars(players) {
  hpBarsEl.innerHTML = players
    .map(
      (p) => `
      <div class="hp-chip ${p.alive ? '' : 'dead'}">
        <span class="dot" style="background:${p.color}"></span>
        <span>${p.name}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(0, p.hp)}%; background:${p.color}"></span></span>
      </div>`
    )
    .join('');
}

function renderHockey(state) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const S = RENDER_SCALE;
  const RINK_HALF_W = 350 * S;
  const RINK_HALF_H = 190 * S;
  const GOAL_HALF_H = 60 * S;

  // rink
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(cx - RINK_HALF_W, cy - RINK_HALF_H, RINK_HALF_W * 2, RINK_HALF_H * 2);
  ctx.beginPath();
  ctx.moveTo(cx, cy - RINK_HALF_H);
  ctx.lineTo(cx, cy + RINK_HALF_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.stroke();

  // goals (blue defends right, red defends left)
  ctx.strokeStyle = '#4cc9f0';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx + RINK_HALF_W, cy - GOAL_HALF_H);
  ctx.lineTo(cx + RINK_HALF_W, cy + GOAL_HALF_H);
  ctx.stroke();
  ctx.strokeStyle = '#e63946';
  ctx.beginPath();
  ctx.moveTo(cx - RINK_HALF_W, cy - GOAL_HALF_H);
  ctx.lineTo(cx - RINK_HALF_W, cy + GOAL_HALF_H);
  ctx.stroke();

  // players
  state.players.forEach((p) => {
    const x = cx + p.x * S;
    const y = cy + p.y * S;
    ctx.beginPath();
    ctx.arc(x, y, 16 * S, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    if (p.dashing) { ctx.shadowColor = p.color; ctx.shadowBlur = 22; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = p.identityColor || '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 24 * S);
    drawPingWarning(x, y, p.pingMs);
  });

  // pass preview (faint dashed aim line)
  if (state.passPreview) {
    const from = { x: cx + state.passPreview.from.x * S, y: cy + state.passPreview.from.y * S };
    const to = { x: cx + state.passPreview.to.x * S, y: cy + state.passPreview.to.y * S };
    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = state.passPreview.color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  // ball
  const bx = cx + state.ball.x * S;
  const by = cy + state.ball.y * S;
  ctx.beginPath();
  ctx.arc(bx, by, 10 * S, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = state.ball.holderId ? 15 : 6;
  ctx.fill();
  ctx.shadowBlur = 0;
}
