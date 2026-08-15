const socket = io();

const joinScreen = document.getElementById('join-screen');
const waitingScreen = document.getElementById('waiting-screen');
const controllerScreen = document.getElementById('controller-screen');
const statusScreen = document.getElementById('status-screen');
const rotateHint = document.getElementById('rotate-hint');

const roomInput = document.getElementById('room-input');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const mySwatch = document.getElementById('my-swatch');
const waitingHint = document.getElementById('waiting-hint');
const teamSelect = document.getElementById('team-select');
const teamRedBtn = document.getElementById('team-red-btn');
const teamBlueBtn = document.getElementById('team-blue-btn');
const pingBadge = document.getElementById('ping-badge');

const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');
const actionsArena = document.getElementById('actions-arena');
const actionsHockey = document.getElementById('actions-hockey');
const dashBtn = document.getElementById('dash-btn');
const passBtn = document.getElementById('pass-btn');
const actionBtn = document.getElementById('action-btn');
const statusText = document.getElementById('status-text');

const joystick = createJoystick(joystickBase, joystickKnob);

// Screens that need the phone in landscape to be usable.
const LANDSCAPE_SCREENS = [waitingScreen, controllerScreen, statusScreen];

function showScreen(el) {
  [joinScreen, waitingScreen, controllerScreen, statusScreen].forEach((s) => s.classList.add('hidden'));
  el.classList.remove('hidden');
  updateRotateHint();
}

function updateRotateHint() {
  const isPortrait = window.matchMedia('(orientation: portrait)').matches;
  const needsLandscape = LANDSCAPE_SCREENS.some((s) => !s.classList.contains('hidden'));
  rotateHint.classList.toggle('hidden', !(isPortrait && needsLandscape));
}
window.addEventListener('resize', updateRotateHint);
window.addEventListener('orientationchange', updateRotateHint);

function tryLockLandscape() {
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {
      /* Not supported on this browser (common on iOS Safari) — the rotate
         hint overlay covers this case instead. */
    });
  }
}

// ---- Remember the player's name on this phone ----
const NAME_KEY = 'partyGamesPlayerName';
const savedName = localStorage.getItem(NAME_KEY);
if (savedName) nameInput.value = savedName;

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
    localStorage.setItem(NAME_KEY, name);
    tryLockLandscape();

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
    teamSelect.classList.toggle('hidden', myGameType !== 'hockey');

    // Drop straight into a live game if we joined mid-round instead of
    // making the player wait through a lobby screen that's already over.
    if (res.phase === 'playing') {
      showScreen(controllerScreen);
    } else if (res.phase === 'countdown' && res.countdownStartsAt) {
      showScreen(waitingScreen);
      const delay = Math.max(0, res.countdownStartsAt - Date.now());
      setTimeout(() => showScreen(controllerScreen), delay);
    } else {
      showScreen(waitingScreen);
    }
  });
}

// ---- Team selection (Puck Rush only, lobby phase only) ----
teamRedBtn.addEventListener('click', () => socket.emit('player:selectTeam', { team: 'red' }));
teamBlueBtn.addEventListener('click', () => socket.emit('player:selectTeam', { team: 'blue' }));

socket.on('lobby:update', ({ players }) => {
  const me = players.find((p) => p.id === myId);
  if (!me) return;
  mySwatch.style.background = me.color;
  mySwatch.style.color = me.color;
  if (me.team) {
    teamRedBtn.classList.toggle('active', me.team === 'red');
    teamBlueBtn.classList.toggle('active', me.team === 'blue');
  }
});

// Host switched games in-place — same room, new controls, no rejoin needed.
socket.on('game:changed', ({ gameType }) => {
  myGameType = gameType;
  eliminatedThisRound = false;
  actionsArena.classList.toggle('hidden', myGameType !== 'arena');
  actionsHockey.classList.toggle('hidden', myGameType !== 'hockey');
  teamSelect.classList.toggle('hidden', myGameType !== 'hockey');
  showScreen(waitingScreen);
});

// Host restarted the same game — jump back to the waiting screen automatically.
socket.on('game:reset', () => {
  eliminatedThisRound = false;
  showScreen(waitingScreen);
});

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

// ---- Latency badge (visible at all times, updates every 2s) ----
function updatePingBadge(ms) {
  pingBadge.textContent = `${ms}ms`;
  pingBadge.classList.toggle('ping-good', ms < 100);
  pingBadge.classList.toggle('ping-ok', ms >= 100 && ms < 250);
  pingBadge.classList.toggle('ping-bad', ms >= 250);
}
function checkPing() {
  const start = Date.now();
  socket.emit('ping:check', null, () => {
    const rtt = Date.now() - start;
    updatePingBadge(rtt);
    socket.emit('player:pingReport', rtt);
  });
}
setInterval(checkPing, 2000);
checkPing();

updateRotateHint();
