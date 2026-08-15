const TICK_MS = 1000 / 45;
const MAX_PLAYERS = 10;

// --- rink layout (world units, centered at 0,0 — same scale as Arena Battle) ---
const RINK_HALF_W = 350;
const RINK_HALF_H = 190;
const GOAL_HALF_H = 60;

const PLAYER_RADIUS = 16;
const BALL_RADIUS = 10;

// --- movement feel (shared tuning with Arena Battle, so it feels familiar) ---
const BASE_SPEED = 210;
const ACCEL = 1700;
const DASH_ACCEL_MULT = 2.4;
const FRICTION = 1500;
const DASH_MULT = 2.5;
const DASH_DURATION = 200;
const DASH_COOLDOWN = 1300;
const CHECK_IMPULSE = 460; // knockback when dashing into another player

// --- ball / possession ---
const BALL_FRICTION = 260;
const BALL_WALL_BOUNCE = 0.8;
const PICKUP_RADIUS = 34;
const HOLD_OFFSET = 26;
const SHOOT_SPEED = 640;
const PASS_SPEED = 380;
const PASS_PREVIEW_LEN = 260;
const REPICKUP_BLOCK_MS = 260; // brief grace period so a stolen/shot ball can't be instantly re-caught by the same player

const WIN_SCORE = 5;
const MATCH_DURATION = 150000; // 2.5 minutes

const TEAM_COLOR = { red: '#e63946', blue: '#4cc9f0' };

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

class PuckRushRoom {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.gameType = 'hockey';
    this.state = 'lobby';
    this.players = new Map();
    this.hostSocketId = null;
    this.loopHandle = null;
    this.matchStart = 0;
    this.countdownStartsAt = null;
    this.score = { red: 0, blue: 0 };
    this.ball = { x: 0, y: 0, vx: 0, vy: 0, holderId: null };
  }

  addPlayer(socketId, name) {
    if (this.players.size >= MAX_PLAYERS) return null;
    const redCount = [...this.players.values()].filter((p) => p.team === 'red').length;
    const blueCount = this.players.size - redCount;
    const team = redCount <= blueCount ? 'red' : 'blue';
    const player = {
      id: socketId,
      name: (name || 'Player').slice(0, 12),
      color: TEAM_COLOR[team],
      team,
      x: team === 'red' ? -150 : 150,
      y: 0,
      vx: 0,
      vy: 0,
      input: { dx: 0, dy: 0, passHeld: false },
      prevPassHeld: false,
      facingX: team === 'red' ? 1 : -1,
      facingY: 0,
      lastDash: -99999,
      dashUntil: 0,
      pickupBlockedUntil: 0,
      pingMs: null,
      connected: true,
    };
    this.players.set(socketId, player);
    // Only reflow everyone into a neat kickoff formation before a game has
    // started — repositioning active players mid-match would teleport them.
    if (this.state === 'lobby') this.layoutKickoff();
    return player;
  }

  setTeam(id, team) {
    if (this.state !== 'lobby') return; // only choosable pre-match
    const p = this.players.get(id);
    if (!p || (team !== 'red' && team !== 'blue')) return;
    p.team = team;
    p.color = TEAM_COLOR[team];
    p.facingX = team === 'red' ? 1 : -1;
    this.layoutKickoff();
  }

  setPing(id, ms) {
    const p = this.players.get(id);
    if (p) p.pingMs = typeof ms === 'number' ? Math.round(ms) : null;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    if (this.ball.holderId === id) this.ball.holderId = null;
    if (this.state === 'lobby') this.players.delete(id);
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || this.state !== 'playing') return;
    if (typeof input.dx === 'number') p.input.dx = clamp(input.dx, -1, 1);
    if (typeof input.dy === 'number') p.input.dy = clamp(input.dy, -1, 1);
    if (typeof input.passHeld === 'boolean') p.input.passHeld = input.passHeld;
    if (input.action) this.tryAction(p);
  }

  tryAction(p) {
    if (this.ball.holderId === p.id) {
      this.releaseBall(p, SHOOT_SPEED);
    } else {
      const now = Date.now();
      if (now - p.lastDash >= DASH_COOLDOWN) {
        p.lastDash = now;
        p.dashUntil = now + DASH_DURATION;
      }
    }
  }

  aimDir(p) {
    const mag = Math.hypot(p.input.dx, p.input.dy);
    if (mag > 0.05) return { x: p.input.dx / Math.max(mag, 1), y: p.input.dy / Math.max(mag, 1) };
    return { x: p.facingX, y: p.facingY };
  }

  releaseBall(p, speed) {
    const dir = this.aimDir(p);
    this.ball.vx = dir.x * speed;
    this.ball.vy = dir.y * speed;
    this.ball.holderId = null;
    p.pickupBlockedUntil = Date.now() + REPICKUP_BLOCK_MS;
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby:update', {
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        connected: p.connected,
        pingMs: p.pingMs,
      })),
    });
  }

  layoutKickoff() {
    const byTeam = { red: [], blue: [] };
    for (const p of this.players.values()) byTeam[p.team].push(p);
    for (const team of ['red', 'blue']) {
      const list = byTeam[team];
      const sideX = team === 'red' ? -150 : 150;
      list.forEach((p, i) => {
        const spread = list.length > 1 ? (i / (list.length - 1) - 0.5) * 220 : 0;
        p.x = sideX;
        p.y = spread;
        p.vx = 0;
        p.vy = 0;
        p.dashUntil = 0;
      });
    }
    this.ball.x = 0;
    this.ball.y = 0;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.holderId = null;
  }

  startGame() {
    if (this.players.size < 2 || this.state !== 'lobby') return;
    this.state = 'countdown';
    this.score = { red: 0, blue: 0 };
    this.layoutKickoff();
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
      if (!p.connected) this.players.delete(id);
    }
    this.layoutKickoff();
    this.broadcastLobby();
    this.io.to(this.code).emit('game:reset');
  }

  beginLoop() {
    clearInterval(this.loopHandle);
    this.loopHandle = setInterval(() => this.tick(), TICK_MS);
  }

  scoreGoal(scoringTeam) {
    this.score[scoringTeam] += 1;
    this.io.to(this.code).emit('goal:scored', { team: scoringTeam, score: { ...this.score } });
    this.layoutKickoff();
    if (this.score[scoringTeam] >= WIN_SCORE) this.endGame();
  }

  tick() {
    const dt = TICK_MS / 1000;
    const now = Date.now();
    const players = [...this.players.values()].filter((p) => p.connected);

    // --- player movement (same acceleration/friction/dash feel as Arena Battle) ---
    for (const p of players) {
      const dashing = now < p.dashUntil;
      const topSpeed = BASE_SPEED * (dashing ? DASH_MULT : 1);
      const mag = Math.hypot(p.input.dx, p.input.dy);
      const hasInput = mag > 0.05;

      if (hasInput) {
        const dirX = p.input.dx / Math.max(mag, 1);
        const dirY = p.input.dy / Math.max(mag, 1);
        p.facingX = dirX;
        p.facingY = dirY;
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
      p.x = clamp(p.x, -RINK_HALF_W + PLAYER_RADIUS, RINK_HALF_W - PLAYER_RADIUS);
      p.y = clamp(p.y, -RINK_HALF_H + PLAYER_RADIUS, RINK_HALF_H - PLAYER_RADIUS);
    }

    // --- player vs player: soft separation + dash check (knockback, and steals the ball) ---
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
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
          const check = (attacker, victim, dirX, dirY) => {
            victim.vx += dirX * CHECK_IMPULSE;
            victim.vy += dirY * CHECK_IMPULSE;
            if (this.ball.holderId === victim.id && attacker.team !== victim.team) {
              this.ball.vx = dirX * 180;
              this.ball.vy = dirY * 180;
              this.ball.holderId = null;
              victim.pickupBlockedUntil = now + REPICKUP_BLOCK_MS;
              this.io.to(this.code).emit('fx:steal', { by: attacker.id, from: victim.id });
            }
          };
          if (aDashing && !bDashing) check(a, b, nx, ny);
          else if (bDashing && !aDashing) check(b, a, -nx, -ny);
        }
      }
    }

    // --- ball physics ---
    const holder = this.ball.holderId ? this.players.get(this.ball.holderId) : null;
    if (holder) {
      const dir = this.aimDir(holder);
      this.ball.x = holder.x + dir.x * HOLD_OFFSET;
      this.ball.y = holder.y + dir.y * HOLD_OFFSET;
      this.ball.vx = 0;
      this.ball.vy = 0;
    } else {
      const speed = Math.hypot(this.ball.vx, this.ball.vy);
      if (speed > 0) {
        const decel = Math.min(speed, BALL_FRICTION * dt);
        this.ball.vx -= (this.ball.vx / speed) * decel;
        this.ball.vy -= (this.ball.vy / speed) * decel;
      }
      this.ball.x += this.ball.vx * dt;
      this.ball.y += this.ball.vy * dt;

      if (this.ball.y > RINK_HALF_H - BALL_RADIUS) {
        this.ball.y = RINK_HALF_H - BALL_RADIUS;
        this.ball.vy = -this.ball.vy * BALL_WALL_BOUNCE;
      } else if (this.ball.y < -RINK_HALF_H + BALL_RADIUS) {
        this.ball.y = -RINK_HALF_H + BALL_RADIUS;
        this.ball.vy = -this.ball.vy * BALL_WALL_BOUNCE;
      }

      if (this.ball.x > RINK_HALF_W - BALL_RADIUS) {
        if (Math.abs(this.ball.y) < GOAL_HALF_H) {
          this.scoreGoal('red'); // ball crossed blue's line -> red scores
          return;
        }
        this.ball.x = RINK_HALF_W - BALL_RADIUS;
        this.ball.vx = -this.ball.vx * BALL_WALL_BOUNCE;
      } else if (this.ball.x < -RINK_HALF_W + BALL_RADIUS) {
        if (Math.abs(this.ball.y) < GOAL_HALF_H) {
          this.scoreGoal('blue'); // ball crossed red's line -> blue scores
          return;
        }
        this.ball.x = -RINK_HALF_W + BALL_RADIUS;
        this.ball.vx = -this.ball.vx * BALL_WALL_BOUNCE;
      }

      // pickup: nearest eligible player within radius
      let best = null;
      let bestDist = PICKUP_RADIUS;
      for (const p of players) {
        if (now < p.pickupBlockedUntil) continue;
        const d = Math.hypot(p.x - this.ball.x, p.y - this.ball.y);
        if (d < bestDist) {
          best = p;
          bestDist = d;
        }
      }
      if (best) this.ball.holderId = best.id;
    }

    // --- pass: charge while held, release on button-up ---
    let passPreview = null;
    for (const p of players) {
      if (this.ball.holderId === p.id && p.input.passHeld) {
        const dir = this.aimDir(p);
        const to = this.clipToRink(this.ball.x, this.ball.y, dir.x, dir.y, PASS_PREVIEW_LEN);
        passPreview = { from: { x: this.ball.x, y: this.ball.y }, to, color: p.color };
      }
      if (p.prevPassHeld && !p.input.passHeld && this.ball.holderId === p.id) {
        this.releaseBall(p, PASS_SPEED);
      }
      p.prevPassHeld = p.input.passHeld;
    }

    // --- match timer ---
    const elapsed = now - this.matchStart;
    const timeRemaining = Math.max(0, MATCH_DURATION - elapsed);
    if (this.state === 'playing' && timeRemaining <= 0) {
      this.endGame();
      return;
    }

    this.io.to(this.code).emit('state:update', {
      gameType: 'hockey',
      score: { ...this.score },
      timeRemaining,
      ball: { x: this.ball.x, y: this.ball.y, holderId: this.ball.holderId },
      passPreview,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        team: p.team,
        x: p.x,
        y: p.y,
        dashing: now < p.dashUntil,
        connected: p.connected,
        pingMs: p.pingMs,
      })),
    });
  }

  clipToRink(x0, y0, dx, dy, len) {
    let t = len;
    if (dx !== 0) {
      const tx = ((dx > 0 ? RINK_HALF_W : -RINK_HALF_W) - x0) / dx;
      if (tx > 0) t = Math.min(t, tx);
    }
    if (dy !== 0) {
      const ty = ((dy > 0 ? RINK_HALF_H : -RINK_HALF_H) - y0) / dy;
      if (ty > 0) t = Math.min(t, ty);
    }
    return { x: x0 + dx * t, y: y0 + dy * t };
  }

  endGame() {
    this.state = 'ended';
    clearInterval(this.loopHandle);
    const winnerTeam =
      this.score.red === this.score.blue ? null : this.score.red > this.score.blue ? 'red' : 'blue';
    this.io.to(this.code).emit('game:ended', {
      mode: 'hockey',
      winnerTeam,
      score: { ...this.score },
    });
  }

  destroy() {
    clearInterval(this.loopHandle);
  }
}

module.exports = { PuckRushRoom, RINK_HALF_W, RINK_HALF_H, GOAL_HALF_H };
