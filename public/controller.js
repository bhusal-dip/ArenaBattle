const socket = io();

const joinScreen = document.getElementById('join-screen');
const waitingScreen = document.getElementById('waiting-screen');
const controllerScreen = document.getElementById('controller-screen');
const statusScreen = document.getElementById('status-screen');

const roomInput = document.getElementById('room-input');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const mySwatch = document.getElementById('my-swatch');
const waitingHint = document.getElementById('waiting-hint');

const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');
const actionsArena = document.getElementById('actions-arena');
const actionsHockey = document.getElementById('actions-hockey');
const dashBtn = document.getElementById('dash-btn');
const passBtn = document.getElementById('pass-btn');
const actionBtn = document.getElementById('action-btn');
const statusText = document.getElementById('status-text');

const joystick = createJoystick(joystickBase, joystickKnob);

function showScreen(el) {
  [joinScreen, waitingScreen, controllerScreen, statusScreen].forEach((s) => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

// Pre-fill room code from ?room=XXXX in the QR link
const params = new URLSearchParams(window.location.search);
if (params.get('room')) roomInput.value = params.get('room').toUpperCase();

let myId = null;
let myGameType = 'arena';
let eliminatedThisRound = false;
let passHeld = false;

joinBtn.addEventListener('click', doJoin);
function doJoin() {
  const roomCode = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim() || 'Player';
  if (roomCode.length !== 4) {
    joinError.textContent = 'Enter the 4-letter room code.';
    return;
  }
  joinBtn.disabled = true;
  socket.emit('player:join', { roomCode, name }, (res) => {
    joinBtn.disabled = false;
    if (!res.ok) {
      joinError.textContent = res.error;
      return;
    }
    joinError.textContent = '';
    myId = res.player.id;
    myGameType = res.gameType;
    eliminatedThisRound = false;

    mySwatch.style.background = res.player.color;
    mySwatch.style.color = res.player.color;
    waitingHint.textContent = res.player.team
      ? `You're in! Team ${res.player.team.toUpperCase()} — waiting for host to start…`
      : "You're in! Waiting for host to start…";

    actionsArena.classList.toggle('hidden', myGameType !== 'arena');
    actionsHockey.classList.toggle('hidden', myGameType !== 'hockey');

    showScreen(waitingScreen);
  });
}

// The server flips state to 'playing' shortly after countdown starts.
// We show controls as soon as countdown begins so players are ready to move at "GO".
socket.on('game:countdown', ({ startsAt }) => {
  eliminatedThisRound = false;
  const delay = Math.max(0, startsAt - Date.now());
  setTimeout(() => showScreen(controllerScreen), delay);
});

socket.on('fx:hit', (hits) => {
  if (!navigator.vibrate) return;
  if (hits.some((h) => h.victimId === myId)) navigator.vibrate(60);
});

socket.on('fx:steal', ({ from }) => {
  if (from === myId && navigator.vibrate) navigator.vibrate([40, 30, 40]);
});

socket.on('player:eliminated', ({ id, placement }) => {
  if (id !== myId) return;
  eliminatedThisRound = true;
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  statusText.textContent = `You're out — ${ordinal(placement)} place. Watch the big screen!`;
  showScreen(statusScreen);
});

socket.on('goal:scored', ({ team }) => {
  if (navigator.vibrate) navigator.vibrate(team ? 50 : 0);
});

socket.on('game:ended', (payload) => {
  if (payload.mode === 'hockey') {
    statusText.textContent = payload.winnerTeam
      ? `${payload.winnerTeam.toUpperCase()} wins ${payload.score.red}–${payload.score.blue}!`
      : `Draw ${payload.score.red}–${payload.score.blue}`;
  } else {
    const iWon = payload.winner && payload.winner.id === myId;
    statusText.textContent = iWon ? 'You WIN! 🏆' : payload.winner ? `${payload.winner.name} wins!` : 'Round over!';
  }
  showScreen(statusScreen);
});

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Arena Battle: Dash ----
let dashCooldownUntil = 0;
const DASH_COOLDOWN_MS = 1300; // mirrors server value, for UI feedback only

dashBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (eliminatedThisRound) return;
  const now = Date.now();
  if (now < dashCooldownUntil) return;
  dashCooldownUntil = now + DASH_COOLDOWN_MS;
  socket.emit('player:input', { dx: joystick.dx, dy: joystick.dy, dash: true });
  if (navigator.vibrate) navigator.vibrate(40);
  dashBtn.classList.add('on-cooldown');
  setTimeout(() => dashBtn.classList.remove('on-cooldown'), DASH_COOLDOWN_MS);
});

// ---- Puck Rush: Shoot/Dash (server decides which, based on possession) ----
actionBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  socket.emit('player:input', { dx: joystick.dx, dy: joystick.dy, action: true });
  if (navigator.vibrate) navigator.vibrate(35);
});

// ---- Puck Rush: Pass — hold to aim (server streams back a live preview line
// on the host screen), release to throw. Only does anything if you're holding the ball. ----
passBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  passHeld = true;
});
function releasePass() {
  if (!passHeld) return;
  passHeld = false;
  socket.emit('player:input', { dx: joystick.dx, dy: joystick.dy, passHeld: false });
}
passBtn.addEventListener('pointerup', releasePass);
passBtn.addEventListener('pointercancel', releasePass);

// ---- Send movement (+ hockey pass-hold state) at a steady low-latency rate ----
setInterval(() => {
  if (controllerScreen.classList.contains('hidden') || eliminatedThisRound) return;
  const payload = { dx: joystick.dx, dy: joystick.dy };
  if (myGameType === 'hockey') payload.passHeld = passHeld;
  socket.emit('player:input', payload);
}, 50); // 20 times/sec
