# Arena Battle — Local Multiplayer Party Game

A single-screen, local-WiFi multiplayer game. One computer runs the game and
shows it on a TV/monitor; players join as controllers on their own phones by
scanning a QR code — no app install needed.

**Game: Bumper Blobs.** Steer your blob with a joystick, tap DASH to speed up
and knock other players back (and damage them). Standing outside the shrinking
arena drains your health. Last blob standing wins.

Supports 2–10 players. Everything runs over your local WiFi — no internet
connection is required once it's set up.

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

1. The host screen shows a QR code and a 4-letter room code.
2. Each player scans the QR code with their phone camera (or opens
   `http://<the-same-IP>:3000/controller.html` and types in the room code
   manually), types their name, and taps **Join Game**.
3. Once at least 2 players have joined, the host clicks **Start Game**.
4. After a 3-2-1 countdown, players use the on-screen joystick to move and
   the DASH button to attack/boost. Last player standing wins.
5. Host clicks **Play Again** to return everyone to the lobby for another
   round.

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
    index.js       — Express + Socket.io server, room/session management
    Room.js         — game rules: movement, dash, collisions, shrinking arena
  public/
    host.html/css/js       — the big-screen display
    controller.html/css/js — the phone controller (joystick + dash)
  package.json
```

## Adding more games later

The room/session/QR-join plumbing in `server/index.js` is written to be
game-agnostic. To add a second game:

1. Duplicate `Room.js`'s game-logic pieces (state, `tick()`, input handling)
   into a new class, or add a `gameType` field and branch inside `Room`.
2. Add a new `public/<game>.html/js` controller layout suited to that game's
   inputs (buttons, swipe, tilt, etc.) and a matching host renderer.
3. Let the host choose which game to launch before creating the room.

The networking layer (Socket.io rooms, QR join, lobby flow) does not need to
change between games.
