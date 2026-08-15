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
const announcementsEl = document.getElementById('announcements');

const GAME_LABELS = { arena: 'Arena Battle', hockey: 'Puck Rush' };
let currentGameType = 'arena';

function showScreen(el) {
  [selectScreen, lobbyScreen, countdownScreen, gameScreen, endScreen].forEach((s) => s.classList.add('hidden'));
  el.classList.remove('hidden');
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
document.querySelectorAll('.game-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    unlockAudio(); // arm audio here too, in case Start is clicked quickly after
    const gameType = btn.dataset.game;
    currentGameType = gameType;
    lobbyTitle.innerHTML = `${GAME_LABELS[gameType].toUpperCase()} <span>LOBBY</span>`;
    scoreHud.classList.toggle('hidden', gameType !== 'hockey');
    hpBarsEl.classList.toggle('hidden', gameType !== 'arena');
    socket.emit('host:create', { gameType });
  });
});

socket.on('host:created', ({ code, joinUrl, qrDataUrl, gameType }) => {
  currentGameType = gameType;
  roomCodeText.textContent = code;
  joinUrlText.textContent = joinUrl;
  if (qrDataUrl) qrImg.src = qrDataUrl;
  showScreen(lobbyScreen);
});

socket.on('lobby:update', ({ players }) => {
  playerCountEl.textContent = players.length;
  playerListEl.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    const teamTag = p.team ? ` (${p.team})` : '';
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.name}${teamTag}`;
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
restartBtn.addEventListener('click', () => {
  showScreen(selectScreen);
  socket.emit('host:restart');
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
  }
});

socket.on('fx:hit', () => playHitSound());
socket.on('fx:steal', () => playHitSound());

socket.on('player:eliminated', ({ name, color, placement }) => {
  playEliminationSound();
  showAnnouncement(`${name} eliminated — ${ordinal(placement)} place`, color);
});

socket.on('goal:scored', ({ team }) => {
  playGoalSound();
  const color = team === 'red' ? '#e63946' : '#4cc9f0';
  showAnnouncement(`GOAL! ${team.toUpperCase()} scores`, color);
});

socket.on('game:ended', (payload) => {
  playWinSound();
  if (payload.mode === 'hockey') {
    const { winnerTeam, score } = payload;
    if (winnerTeam) {
      winnerNameEl.textContent = `${winnerTeam.toUpperCase()} WINS ${score.red}–${score.blue}`;
      winnerNameEl.style.color = winnerTeam === 'red' ? '#e63946' : '#4cc9f0';
    } else {
      winnerNameEl.textContent = `DRAW ${score.red}–${score.blue}`;
      winnerNameEl.style.color = '#fff';
    }
  } else {
    const { winner } = payload;
    winnerNameEl.textContent = winner ? winner.name : 'No one (draw)';
    winnerNameEl.style.color = winner ? winner.color : '#fff';
  }
  showScreen(endScreen);
});

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

function renderArena(state) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  ctx.beginPath();
  ctx.arc(cx, cy, state.arenaR, 0, Math.PI * 2);
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
    const x = cx + p.x;
    const y = cy + p.y;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    if (p.dashing) { ctx.shadowColor = p.color; ctx.shadowBlur = 25; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 26);
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
  const RINK_HALF_W = 350;
  const RINK_HALF_H = 190;
  const GOAL_HALF_H = 60;

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
    const x = cx + p.x;
    const y = cy + p.y;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    if (p.dashing) { ctx.shadowColor = p.color; ctx.shadowBlur = 22; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - 24);
  });

  // pass preview (faint dashed aim line)
  if (state.passPreview) {
    const from = { x: cx + state.passPreview.from.x, y: cy + state.passPreview.from.y };
    const to = { x: cx + state.passPreview.to.x, y: cy + state.passPreview.to.y };
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
  const bx = cx + state.ball.x;
  const by = cy + state.ball.y;
  ctx.beginPath();
  ctx.arc(bx, by, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = state.ball.holderId ? 15 : 6;
  ctx.fill();
  ctx.shadowBlur = 0;
}
