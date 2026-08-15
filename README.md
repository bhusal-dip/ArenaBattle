# Party Games — Local Multiplayer

A single-screen, local-WiFi multiplayer party game platform. One computer runs
the game and shows it on a TV/monitor; players join as controllers on their
own phones by scanning a QR code — no app install needed.

Everything runs over your local WiFi — no internet connection is required
once it's set up. Supports 2–10 players.

## Games

**Arena Battle.** Steer your blob with a joystick, tap DASH to speed up and
knock other players back. Standing outside the shrinking arena drains your
health. Last blob standing wins.

**Puck Rush.** 2 teams, one puck, two goals. Move with the joystick — the
same button doubles as **Shoot** (if you're holding the puck) or **Dash**
(a body-check that knocks the puck loose from an opponent). A separate
**Pass** button: hold it to aim (a faint line on the big screen shows where
it'll go, updating live as you move the joystick), release to throw. First
to 5 goals, or highest score when the clock runs out, wins.

The host picks which game to launch from a game-select screen before the QR
code is generated.

---

## 1. Requirements

- [Node.js](https://nodejs.org) v18 or newer, installed on the computer that
  will act as the "host" (the one connected to the TV/monitor).
- All players' phones and the host computer must be on the **same WiFi
  network**. (Guest/isolated WiFi networks that block device-to-device
  traffic — common on some public/office WiFi — will NOT work. Use a home
  router or a phone hotspot if unsure.)

## 2. Install

Open a terminal in this folder and run:

```bash
npm install
```

## 3. Run

```bash
npm start
```

You'll see something like:

```
Arena Battle is running!
Host screen (open on the TV/laptop): http://192.168.1.42:3000/host.html
```

Open that `host.html` URL in a browser **on the host computer**, and put that
browser window/tab on the TV or monitor everyone will look at.

## 4. Play

1. On the host screen, pick a game (Arena Battle or Puck Rush). This shows a
   QR code and a 4-letter room code.
2. Each player scans the QR code with their phone camera (or opens
   `http://<the-same-IP>:3000/controller.html` and types in the room code
   manually), types their name, and taps **Join Game**. In Puck Rush,
   players are auto-assigned to Red/Blue teams alternately as they join.
3. Once at least 2 players have joined, the host clicks **Start Game**.
4. After a 3-2-1 countdown, players use the on-screen joystick to move.
   - **Arena Battle:** tap DASH to speed up and knock others back.
   - **Puck Rush:** tap SHOOT/DASH (shoots if you have the puck, otherwise
     body-checks); hold PASS to aim, release to throw to a teammate.
5. Host clicks **Play Again** to return to the game-select screen for
   another round (same or different game).

## Deploying somewhere instead of running locally

Short answer: **it will still work, but it won't feel quite the same**, mainly
because of latency and one infra difference.

- **Latency.** On your own WiFi, phone → server → screen round-trips are
  usually 1–5ms. Over the internet to a cloud server, that becomes roughly
  20–100ms+ depending on distance and everyone's connection — still very
  playable for this kind of game (it's not a frame-perfect fighting game),
  but movement will feel a touch less instant than local play.
- **The QR/join link now points at your server's real address instead of a
  LAN IP** — this already works with no changes needed: the code builds the
  join link from the browser's own origin (`socket.handshake.headers.origin`),
  so it automatically uses your local IP when run on your laptop, or your
  real domain once deployed, with no config needed.
- **HTTPS.** Most hosts (Render, Railway, Fly.io, a VPS behind Caddy/Nginx,
  etc.) give you HTTPS automatically, and Socket.io works over it fine (as
  WSS). Not strictly required for this app's features, but good practice
  once it's public.
- **Same-WiFi restriction goes away.** This is the upside — hosted remotely,
  players don't need to share a network, so people could join from anywhere
  (though the "single shared screen" idea is really designed for everyone
  being in the same room).
- **Hosting needs a long-running Node process** (not a serverless function),
  since the game loop and Socket.io connections are persistent. Any small
  VM or PaaS with WebSocket support works.

For a local party, keep running it locally — it's simpler and gives you the
best latency. Deploy it only if you specifically want remote players.

## Session behavior

- **Restarting keeps everyone connected.** "Play Again" reuses the same room
  code — nobody needs to rescan the QR or rejoin.
- **Switching games also keeps the same room code.** "Change Game" on the end
  screen lets the host pick a different game without breaking the session;
  connected players' phones update their controls automatically.
- **Players can join mid-game.** New players who scan the QR while a round is
  already running drop straight into the live game (spawned safely in Arena
  Battle, auto-balanced onto a team in Puck Rush) instead of waiting in a
  lobby. Note: team choice is only available before a Puck Rush match starts
  — a mid-match joiner gets auto-assigned to whichever team is short a player.
- **Names are remembered per phone** (via browser local storage), so
  returning players don't have to retype their name each session.
- **Side/team choice (Puck Rush).** After joining, players see Red/Blue
  buttons on their waiting screen and can pick or switch sides any time the
  room is between rounds.
- **Latency display.** Each phone shows its own ping in the corner at all
  times. The host's lobby list also shows each player's ping, and during
  play, a player's name gets a small "⚠ Xms" flag on the big screen if their
  connection is running slow enough to actually be worth noticing.
- **Controller is landscape-only** for actual gameplay (joystick + buttons)
  — if the phone is in portrait during the waiting/playing/results screens,
  a "rotate your phone" prompt covers the screen until it's rotated. The
  join screen (typing name/room code) stays usable in portrait.

## Troubleshooting

- **Phone can't reach the join page / QR doesn't work:** almost always a WiFi
  issue — confirm the phone is on the exact same network as the host
  computer, and that the network allows devices to talk to each other
  (some public or "guest" WiFi networks block this — a personal hotspot
  from one phone works well as a fallback).
- **Firewall prompt on the host computer:** allow Node.js to accept incoming
  connections on your local network when prompted.
- **Laggy movement:** this shouldn't happen on a normal home WiFi network,
  but if it does, reduce the number of other devices heavily using the same
  WiFi (e.g. large downloads/streaming) during play.

## Project structure

```
arena-battle/
  server/
    index.js               — Express + Socket.io server, room/session management
    roomFactory.js          — maps a gameType string to its Room class
    games/
      ArenaBattleRoom.js     — Arena Battle rules: movement, dash, shrinking arena
      PuckRushRoom.js        — Puck Rush rules: teams, ball physics, shoot/pass/checking
  public/
    host.html/css/js         — the big-screen display (game-select + both renderers)
    controller.html/css/js   — the phone controller (both control layouts)
    joystick.js               — shared analog joystick component
  package.json
```

## Adding a third game

1. Create `server/games/<YourGame>Room.js` implementing the same shape as
   the existing rooms: `addPlayer`, `removePlayer`, `setInput`,
   `broadcastLobby`, `startGame`, `resetToLobby`, `destroy`, plus `code`,
   `state`, `players`, and `gameType` fields. Copy movement/dash constants
   from `ArenaBattleRoom.js` or `PuckRushRoom.js` if you want the same feel.
2. Register it in `server/roomFactory.js`'s `GAME_TYPES` map.
3. Add a `.game-card` button on the host's select screen (`host.html`), and
   a render function in `host.js` branched on `state.gameType`.
4. Add a new hidden `#actions-<yourgame>` block in `controller.html` with
   whatever buttons your game needs, and branch `controller.js` to show/wire
   it up based on `gameType` from the join response. Reuse `joystick.js` for
   movement — no need to rebuild it per game.

The networking layer (Socket.io rooms, QR join, lobby flow) does not need to
change between games.
