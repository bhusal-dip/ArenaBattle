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

const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');
const dashBtn = document.getElementById('dash-btn');
const statusText = document.getElementById('status-text');

function showScreen(el) {
  [joinScreen, waitingScreen, controllerScreen, statusScreen].forEach((s) => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

// Pre-fill room code from ?room=XXXX in the QR link
const params = new URLSearchParams(window.location.search);
if (params.get('room')) roomInput.value = params.get('room').toUpperCase();

let myColor = '#4cc9f0';
let myId = null;
let eliminatedThisRound = false;

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
    myColor = res.player.color;
    mySwatch.style.background = myColor;
    mySwatch.style.color = myColor;
    eliminatedThisRound = false;
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

socket.on('player:eliminated', ({ id, placement }) => {
  if (id !== myId) return;
  eliminatedThisRound = true;
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  statusText.textContent = `You're out — ${ordinal(placement)} place. Watch the big screen!`;
  showScreen(statusScreen);
});

socket.on('game:ended', ({ winner }) => {
  const iWon = winner && winner.id === myId;
  statusText.textContent = iWon ? 'You WIN! 🏆' : winner ? `${winner.name} wins!` : 'Round over!';
  showScreen(statusScreen);
});

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Virtual joystick ----
let joystickActive = false;
let joystickPointerId = null;
let currentDx = 0;
let currentDy = 0;

function getBaseGeometry() {
  const rect = joystickBase.getBoundingClientRect();
  return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, r: rect.width / 2 };
}

function handleJoystickMove(clientX, clientY) {
  const { cx, cy, r } = getBaseGeometry();
  let dx = clientX - cx;
  let dy = clientY - cy;
  const dist = Math.hypot(dx, dy);
  const maxDist = r * 0.9;
  if (dist > maxDist) {
    dx = (dx / dist) * maxDist;
    dy = (dy / dist) * maxDist;
  }
  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  currentDx = dx / maxDist;
  currentDy = dy / maxDist;
}

function resetJoystick() {
  joystickKnob.style.transform = 'translate(-50%, -50%)';
  currentDx = 0;
  currentDy = 0;
}

joystickBase.addEventListener('pointerdown', (e) => {
  joystickActive = true;
  joystickPointerId = e.pointerId;
  joystickBase.setPointerCapture(e.pointerId);
  handleJoystickMove(e.clientX, e.clientY);
});
joystickBase.addEventListener('pointermove', (e) => {
  if (!joystickActive || e.pointerId !== joystickPointerId) return;
  handleJoystickMove(e.clientX, e.clientY);
});
function endJoystick(e) {
  if (e.pointerId !== joystickPointerId) return;
  joystickActive = false;
  joystickPointerId = null;
  resetJoystick();
}
joystickBase.addEventListener('pointerup', endJoystick);
joystickBase.addEventListener('pointercancel', endJoystick);

// ---- Dash button ----
let dashCooldownUntil = 0;
const DASH_COOLDOWN_MS = 1300; // mirrors server value, for UI feedback only

dashBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (eliminatedThisRound) return;
  const now = Date.now();
  if (now < dashCooldownUntil) return;
  dashCooldownUntil = now + DASH_COOLDOWN_MS;
  socket.emit('player:input', { dx: currentDx, dy: currentDy, dash: true });
  if (navigator.vibrate) navigator.vibrate(40);
  dashBtn.classList.add('on-cooldown');
  setTimeout(() => dashBtn.classList.remove('on-cooldown'), DASH_COOLDOWN_MS);
});

// ---- Send movement at a steady low-latency rate ----
// Sending on every pointermove plus a steady interval keeps motion responsive
// without flooding the network; last value wins each tick.
setInterval(() => {
  if (controllerScreen.classList.contains('hidden') || eliminatedThisRound) return;
  socket.emit('player:input', { dx: currentDx, dy: currentDy });
}, 50); // 20 times/sec
