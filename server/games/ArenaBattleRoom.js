const COLORS = [
  '#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93',
  '#ff924c', '#52a675', '#e63946', '#4cc9f0', '#f72585',
];

const MAX_PLAYERS = 10;
const ARENA_R0 = 380;
const ARENA_MIN = 150;
const SHRINK_DURATION = 90000; // ms, time for arena to reach minimum size
const TICK_MS = 1000 / 45; // server simulation tick rate
const PLAYER_RADIUS = 18;

// --- movement feel ---
const BASE_SPEED = 220;          // px/s top speed, normal
const ACCEL = 1700;              // px/s^2, how fast you reach top speed
const DASH_ACCEL_MULT = 2.4;     // dash ramps up speed much faster (punchier start)
const FRICTION = 1500;           // px/s^2, how fast you slow down with no input
const DASH_MULT = 2.5;           // top speed multiplier while dashing
const DASH_DURATION = 200;       // ms of boosted speed
const DASH_COOLDOWN = 1300;      // ms before you can dash again
const STUN_DURATION = 160;       // ms a hit victim can't fight the knockback
const KNOCK_IMPULSE = 520;       // px/s velocity added to a hit victim

const HP_MAX = 100;
const HIT_DAMAGE = 30;
const OUT_OF_ZONE_DPS = 40;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

class ArenaBattleRoom {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.gameType = 'arena';
    this.state = 'lobby'; // lobby | countdown | playing | ended
    this.players = new Map(); // socketId -> player
    this.hostSocketId = null;
    this.loopHandle = null;
    this.matchStart = 0;
    this.countdownStartsAt = null;
    this.remainingCount = 0; // used to compute elimination placements
  }

  addPlayer(socketId, name) {
    if (this.players.size >= MAX_PLAYERS) return null;
    const color = COLORS[this.players.size % COLORS.length];
    const angle = Math.random() * Math.PI * 2;
    // Late joiners (state === 'playing') spawn safely inside the current
    // shrinking arena instead of at a fixed radius that might already be
    // outside the zone.
    const spawnR = this.state === 'playing' ? Math.min(100, this.currentArenaRadius() * 0.4) : 100;
    const player = {
      id: socketId,
      name: (name || 'Player').slice(0, 12),
      color,
      identityColor: color, // Arena Battle colors are already unique per player
      x: Math.cos(angle) * spawnR,
      y: Math.sin(angle) * spawnR,
      vx: 0,
      vy: 0,
      hp: HP_MAX,
      alive: true,
      input: { dx: 0, dy: 0 },
      lastDash: -99999,
      dashUntil: 0,
      stunUntil: 0,
      pingMs: null,
      connected: true,
    };
    this.players.set(socketId, player);
    // A player joining mid-round (or during the pre-round countdown) should
    // still count toward the pool used to compute elimination placements.
    if (this.state === 'countdown' || this.state === 'playing') this.remainingCount += 1;
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    p.alive = false;
    if (this.state === 'lobby') this.players.delete(id);
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state !== 'playing') return;
    if (typeof input.dx === 'number') p.input.dx = clamp(input.dx, -1, 1);
    if (typeof input.dy === 'number') p.input.dy = clamp(input.dy, -1, 1);
    if (input.dash) this.tryDash(p);
  }

  tryDash(p) {
    const now = Date.now();
    if (now - p.lastDash >= DASH_COOLDOWN) {
      p.lastDash = now;
      p.dashUntil = now + DASH_DURATION;
    }
  }

  setPing(id, ms) {
    const p = this.players.get(id);
    if (p) p.pingMs = typeof ms === 'number' ? Math.round(ms) : null;
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby:update', {
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        identityColor: p.identityColor,
        connected: p.connected,
        pingMs: p.pingMs,
      })),
    });
  }

  startGame() {
    if (this.players.size < 2 || this.state !== 'lobby') return;
    this.state = 'countdown';
    this.remainingCount = this.players.size;
    const startsAt = Date.now() + 3000;
    this.countdownStartsAt = startsAt;
    this.io.to(this.code).emit('game:countdown', { startsAt });
    setTimeout(() => {
      if (this.state !== 'countdown') return;
      this.state = 'playing';
      this.countdownStartsAt = null;
      this.matchStart = Date.now();
      this.beginLoop();
    }, 3000);
  }

  resetToLobby() {
    this.state = 'lobby';
    this.countdownStartsAt = null;
    clearInterval(this.loopHandle);
    for (const [id, p] of [...this.players.entries()]) {
      if (!p.connected) {
        this.players.delete(id);
        continue;
      }
      p.hp = HP_MAX;
      p.alive = true;
      p.x = (Math.random() - 0.5) * 150;
      p.y = (Math.random() - 0.5) * 150;
      p.vx = 0;
      p.vy = 0;
      p.dashUntil = 0;
      p.stunUntil = 0;
    }
    this.broadcastLobby();
    this.io.to(this.code).emit('game:reset');
  }

  beginLoop() {
    clearInterval(this.loopHandle);
    this.loopHandle = setInterval(() => this.tick(), TICK_MS);
  }

  currentArenaRadius() {
    const elapsed = Date.now() - this.matchStart;
    const t = clamp(elapsed / SHRINK_DURATION, 0, 1);
    return ARENA_R0 - (ARENA_R0 - ARENA_MIN) * t;
  }

  tick() {
    const dt = TICK_MS / 1000;
    const R = this.currentArenaRadius();
    const now = Date.now();
    const alive = [...this.players.values()].filter((p) => p.alive);

    // --- movement: acceleration + friction, so dash has real momentum ---
    for (const p of alive) {
      const dashing = now < p.dashUntil;
      const stunned = now < p.stunUntil;
      const topSpeed = BASE_SPEED * (dashing ? DASH_MULT : 1);
      const mag = Math.hypot(p.input.dx, p.input.dy);
      const hasInput = mag > 0.05 && !stunned;

      if (hasInput) {
        const dirX = p.input.dx / Math.max(mag, 1);
        const dirY = p.input.dy / Math.max(mag, 1);
        const accel = ACCEL * (dashing ? DASH_ACCEL_MULT : 1);
        p.vx += dirX * accel * dt;
        p.vy += dirY * accel * dt;
      } else {
        const speed = Math.hypot(p.vx, p.vy);
        if (speed > 0) {
          const decel = Math.min(speed, FRICTION * dt);
          p.vx -= (p.vx / speed) * decel;
          p.vy -= (p.vy / speed) * decel;
        }
      }

      const speed = Math.hypot(p.vx, p.vy);
      if (speed > topSpeed) {
        p.vx = (p.vx / speed) * topSpeed;
        p.vy = (p.vy / speed) * topSpeed;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const dist = Math.hypot(p.x, p.y);
      if (dist > R) p.hp -= OUT_OF_ZONE_DPS * dt;
    }

    // --- collisions: separate overlap, apply knockback as a velocity impulse + brief stun ---
    const hits = []; // {victimId, attackerColor} for feedback/sound
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const minDist = PLAYER_RADIUS * 2;
        if (dist < minDist) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (minDist - dist) / 2;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          const aDashing = now < a.dashUntil;
          const bDashing = now < b.dashUntil;

          const applyHit = (attacker, victim, dirX, dirY) => {
            victim.vx += dirX * KNOCK_IMPULSE;
            victim.vy += dirY * KNOCK_IMPULSE;
            victim.hp -= HIT_DAMAGE;
            victim.stunUntil = now + STUN_DURATION;
            hits.push({ victimId: victim.id, attackerColor: attacker.color });
          };

          if (aDashing && !bDashing) applyHit(a, b, nx, ny);
          else if (bDashing && !aDashing) applyHit(b, a, -nx, -ny);
          else if (aDashing && bDashing) {
            a.vx -= nx * KNOCK_IMPULSE * 0.5;
            a.vy -= ny * KNOCK_IMPULSE * 0.5;
            b.vx += nx * KNOCK_IMPULSE * 0.5;
            b.vy += ny * KNOCK_IMPULSE * 0.5;
            a.hp -= HIT_DAMAGE / 2;
            b.hp -= HIT_DAMAGE / 2;
            a.stunUntil = now + STUN_DURATION * 0.6;
            b.stunUntil = now + STUN_DURATION * 0.6;
            hits.push({ victimId: a.id, attackerColor: b.color });
            hits.push({ victimId: b.id, attackerColor: a.color });
          }
        }
      }
    }

    if (hits.length) this.io.to(this.code).emit('fx:hit', hits);

    // --- eliminations, in order, with placement ---
    const justEliminated = [];
    for (const p of alive) {
      if (p.hp <= 0 && p.alive) {
        p.alive = false;
        p.hp = 0;
        justEliminated.push(p);
      }
    }
    for (const p of justEliminated) {
      const placement = this.remainingCount;
      this.remainingCount -= 1;
      this.io.to(this.code).emit('player:eliminated', {
        id: p.id,
        name: p.name,
        color: p.color,
        placement,
      });
    }

    const stillAlive = [...this.players.values()].filter((p) => p.alive);
    if (this.state === 'playing' && stillAlive.length <= 1 && this.players.size >= 2) {
      this.endGame(stillAlive[0] || null);
      return;
    }

    this.io.to(this.code).emit('state:update', {
      arenaR: R,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        identityColor: p.identityColor,
        x: p.x,
        y: p.y,
        hp: p.hp,
        alive: p.alive,
        dashing: now < p.dashUntil,
        pingMs: p.pingMs,
      })),
    });
  }

  endGame(winner) {
    this.state = 'ended';
    clearInterval(this.loopHandle);
    this.io.to(this.code).emit('game:ended', {
      mode: 'arena',
      winner: winner ? { id: winner.id, name: winner.name, color: winner.color } : null,
    });
  }

  destroy() {
    clearInterval(this.loopHandle);
  }
}

module.exports = { ArenaBattleRoom, MAX_PLAYERS };
