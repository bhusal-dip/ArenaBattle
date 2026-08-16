const TICK_MS = 1000 / 45;
const MAX_PLAYERS = 10;

// Individual per-player identity colors (independent of team color), used so
// each player's controller/avatar border has a unique look even though
// teammates share a team fill color in-game.
const IDENTITY_COLORS = [
  '#ea20f8', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93',
  '#ff924c', '#52a675', '#f72585', '#ff9f1c', '#7209b7',
];

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
const PASS_FX_LEN = 260; // length of the brief post-pass trail line
const PASS_FX_DURATION = 320; // ms the trail stays visible after a pass
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
    this.ball = { x: 0, y: 0, vx: 0, vy: 0, holderId: null, lastShooterId: null, lastShooterTeam: null };
    this.passFxLine = null;
    this.passFxUntil = 0;
  }

  addPlayer(socketId, name) {
    if (this.players.size >= MAX_PLAYERS) return null;
    const redCount = [...this.players.values()].filter((p) => p.team === 'red').length;
    const blueCount = this.players.size - redCount;
    const team = redCount <= blueCount ? 'red' : 'blue';
    const identityColor = IDENTITY_COLORS[this.players.size % IDENTITY_COLORS.length];
    const player = {
      id: socketId,
      name: (name || 'Player').slice(0, 12),
      color: TEAM_COLOR[team],
      identityColor,
      team,
      x: team === 'red' ? -150 : 150,
      y: 0,
      vx: 0,
      vy: 0,
      input: { dx: 0, dy: 0 },
      facingX: team === 'red' ? 1 : -1,
      facingY: 0,
      lastDash: -99999,
      dashUntil: 0,
      pickupBlockedUntil: 0,
      pingMs: null,
      goals: 0,
      ownGoals: 0,
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
    if (input.action) this.tryAction(p);
    if (input.pass) this.tryPass(p);
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

  // Pass is a single tap now (not hold-to-aim): if you're holding the ball,
  // it's released immediately toward your current aim direction, plus a
  // brief fading trail line is shown on the host for feedback.
  tryPass(p) {
    if (this.ball.holderId !== p.id) return;
    const from = { x: this.ball.x, y: this.ball.y };
    const dir = this.aimDir(p);
    const to = this.clipToRink(from.x, from.y, dir.x, dir.y, PASS_FX_LEN);
    this.passFxLine = { from, to, color: p.identityColor };
    this.passFxUntil = Date.now() + PASS_FX_DURATION;
    this.releaseBall(p, PASS_SPEED);
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
    this.ball.lastShooterId = p.id;
    this.ball.lastShooterTeam = p.team;
    p.pickupBlockedUntil = Date.now() + REPICKUP_BLOCK_MS;
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby:update', {
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        identityColor: p.identityColor,
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
    this.ball.lastShooterId = null;
    this.ball.lastShooterTeam = null;
    this.passFxLine = null;
    this.passFxUntil = 0;
  }

  startGame() {
    if (this.players.size < 2 || this.state !== 'lobby') return;
    this.state = 'countdown';
    this.score = { red: 0, blue: 0 };
    for (const p of this.players.values()) {
      p.goals = 0;
      p.ownGoals = 0;
    }
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

  // scoringTeam is whichever team's GOAL the ball entered (i.e. the team
  // that benefits). The shooter is read from ball.lastShooterId — if their
  // team differs from scoringTeam, it's an own goal, credited/blamed
  // accordingly, but the score always goes to the team whose net it wasn't.
  scoreGoal(scoringTeam) {
    this.score[scoringTeam] += 1;
    const shooter = this.ball.lastShooterId ? this.players.get(this.ball.lastShooterId) : null;
    const ownGoal = !!(shooter && shooter.team !== scoringTeam);
    if (shooter) {
      if (ownGoal) shooter.ownGoals += 1;
      else shooter.goals += 1;
    }
    this.io.to(this.code).emit('goal:scored', {
      team: scoringTeam,
      score: { ...this.score },
      scorerId: shooter ? shooter.id : null,
      scorerName: shooter ? shooter.name : null,
      scorerColor: shooter ? shooter.identityColor : null,
      ownGoal,
    });
    this.layoutKickoff();
    // if (this.score[scoringTeam] >= WIN_SCORE) this.endGame();
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

      // A carried ball can also score (including into your OWN net) if you
      // walk it across the goal line — not just shots/passes.
      if (Math.abs(this.ball.y) < GOAL_HALF_H) {
        if (this.ball.x > RINK_HALF_W - BALL_RADIUS) {
          this.ball.lastShooterId = holder.id;
          this.ball.lastShooterTeam = holder.team;
          this.scoreGoal('red');
          return;
        }
        if (this.ball.x < -RINK_HALF_W + BALL_RADIUS) {
          this.ball.lastShooterId = holder.id;
          this.ball.lastShooterTeam = holder.team;
          this.scoreGoal('blue');
          return;
        }
      }
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
          this.scoreGoal('red'); // ball crossed blue's line -> red scores (own goal if the shooter was on red)
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
      passPreview: now < this.passFxUntil ? this.passFxLine : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        identityColor: p.identityColor,
        team: p.team,
        x: p.x,
        y: p.y,
        dashing: now < p.dashUntil,
        connected: p.connected,
        pingMs: p.pingMs,
        goals: p.goals,
        ownGoals: p.ownGoals,
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
