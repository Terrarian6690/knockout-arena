# Knockout Arena

A browser-based 2D multiplayer game (currently a **single-player prototype on
an N-player-ready engine** — "Phase 1" (N-player engine), "Phase 2" (clean
engine↔client package boundary), "Phase 3" (headless authoritative server
host), "Phase 4" (rooms, sessions and the server-assigned identity chain),
"Phase 5" (real-time WebSocket transport), "Phase 6" (the browser-side
network client speaking protocol v1), "Phase 7" (the multiplayer lobby
UI) and "Phase 8" (live multiplayer gameplay over the wire) of the
multiplayer prep are done).

## Overview

Played on a circular arena viewed from above. The player controls a pawn, aims
with the mouse, chooses a power level (1–5), and launches to knock opponents
out of the arena. The engine underneath is **player-count agnostic**: a match
is a roster of pawns (1..N), per-pawn aim/power/confirmation, per-pawn
elimination, **simultaneous rounds** (every alive player chooses
independently each round — there is no turn queue and no current player),
and a finished phase with a winner. The app boots into the multiplayer lobby; when the host starts the
match, the **multiplayer game screen** takes over and renders the
authoritative snapshots the server broadcasts — the browser sends player
intents (aim / setPower / confirmLaunch) and draws what comes back,
running no physics of its own. The original one-player screen lives on as
the lobby's "practice solo" mode with its local engine untouched.

The simulation runs at a **fixed 60 Hz timestep** (the render loop exchanges
real frame time for fixed ticks), so physics behaves identically on any
display refresh rate. Elimination is a pure geometric rule: a pawn is out
when it has **completely left the playable floor** (arena geometry + pawn
radius — see `arena.ts`). The check runs for **every** pawn every tick, so a
mover can shove *opponents* over the rim — that is the core mechanic.

## Tech stack

- **TypeScript** throughout
- **React** for UI
- **HTML Canvas** for rendering
- **Matter.js** for deterministic 2D physics
- **ws** for the authoritative server's WebSocket transport
- **Vite** + **Tailwind CSS**

## Architecture: engine / server / client

The codebase is split into three strictly separated packages in place:

```
src/game/    ← the ENGINE: a headless, deterministic simulation package.
               No React, no DOM, no Vite — matter-js is its only dependency.
               Everything outside imports it through ONE module: src/game/index.ts.
src/server/  ← the SERVER: sessions → rooms → authoritative GameHosts on a
               fixed 60 Hz Node timer loop, plus a WebSocket transport
               adapter (protocol v1) around the GameServer facade.
src/client/  ← the CLIENT: the React app (hook, canvas renderer, components).
               Consumes the engine only via its public barrel "../game".
```

The engine is deliberately split from the React UI so multiplayer (rooms,
matchmaking, server-authoritative simulation, bots) can be added later without
rewriting the core. The split is **in-place** (one repo, one `src/`) on
purpose: a workspaces/monorepo extraction (`packages/game` + `apps/client` +
`apps/server`) stays purely mechanical *because* `src/game` is already fully
self-contained — when the server lands, moving the folder and adding a
package.json is all it takes.

There is exactly **one** game instance in the app: `App.tsx` creates it via
`useGame()` and passes the state down as props, so the canvas and the controls
always share the same game state.

### Engine (`src/game/`)

| Module          | Responsibility                                            |
| --------------- | --------------------------------------------------------- |
| `index.ts`      | **Public API surface** — the only module consumers may import. |
| `config.ts`     | Every tunable number (physics, balance, sizes, colors).   |
| `commands.ts`   | Player-attributed intent commands + `PlayerIntent`/`withPlayerId` + structural validation (network-safe). |
| `types.ts`      | Client-facing view types (snapshot contracts).            |
| `state.ts`      | Serializable authoritative `GameState` (N pawns, per-pawn aim/power, winner) + validation + JSON boundary. |
| `project.ts`    | Pure projection `GameState` → `GameStateSnapshot`, localized by a caller-supplied pawn id. |
| `arena.ts`      | Circular arena model + boundary math (server-safe).       |
| `player.ts`     | Pawn model (incl. its own aim + power) + color palette.   |
| `aiming.ts`     | Aim direction + launch-velocity math.                     |
| `roundLogic.ts` | Round state machine: the shared phase + settle counter (simultaneous rounds — no turn queue). |
| `physics.ts`    | The *only* place that knows Matter.js (swap-friendly).    |
| `game.ts`       | Orchestrator: commands → fixed ticks → state; match lifecycle (elimination, finishing, winner). |

### Client (`src/client/`)

| Module                     | Responsibility                                       |
| -------------------------- | ---------------------------------------------------- |
| `useGame.ts`               | React hook bridging engine → UI + the RAF loop; owns the client's local player id (solo mode). |
| `renderer.ts`              | Pure canvas drawing from a snapshot.                 |
| `network/`                 | The multiplayer client: protocol v1 parsing/building, WebSocket lifecycle, external-store state, React provider + hooks (see below). |
| `components/lobby/*`       | The multiplayer lobby: initial screen (create/join), waiting room (roster, host, start/leave). Server-authoritative display only. |
| `components/game/*`       | The multiplayer game screen: authoritative snapshot rendering (canvas via `renderer.ts`), intent-only controls, round/rail, result overlay. No simulation. |
| `SoloGame.tsx`             | The original single-player screen (local engine), kept as the lobby's "practice solo" mode. |
| `App.tsx` / `main.tsx`     | App shell (lobby ↔ solo mode switch) + Vite entry point.                        |
| `components/*`             | Header, arena canvas, control bar, elimination overlay, power selector. |

### Server (`src/server/`) — rooms, sessions, headless authority

| Module                 | Responsibility                                              |
| ---------------------- | ----------------------------------------------------------- |
| `index.ts`             | Public server barrel.                                       |
| `session.ts`           | `Session` — opaque connection identity (the trust root).    |
| `gameHost.ts`          | `createGameHost()` — the authoritative owner of one match.   |
| `roomManager.ts`       | `createRoomManager()` — rooms, seats p0..p3, lifecycle, identity stamping, host identity. |
| `gameServer.ts`        | `createGameServer()` — the session-facing facade (+ `onRoomView` viewer projection). |
| `protocol.ts`          | The wire protocol (v1): pure parsing + message building.    |
| `webSocketTransport.ts`| `createWebSocketTransport()` — the ws adapter around the facade. |

The server is layered: **session** (who is connected) → **room** (who plays in
which match, on which seat) → **GameHost** (the match itself) → **engine**
(the rules). Each layer only knows the one below it; the engine knows nothing
about any of them, and only the transport adapter knows that WebSockets
exist (all enforced by tests).

#### The identity chain

The client is **never** trusted to choose its playerId:

```
connection/session  →  server-assigned playerId  →  room membership
                    →  GameHost.submitCommand(playerId, command)
```

- `connect()` issues an opaque `Session` (unguessable token — the interim
  credential until real authentication exists).
- `createRoom(session)` seats the creator as `p0`; `joinRoom(session, roomId)`
  takes the **lowest free seat** (`p1`, `p2`, `p3` — max 4, duplicates
  impossible by construction).
- `submitCommand(session, command)` **rebuilds** the command from known intent
  fields only, stamped with the session's seat: whatever `playerId` (or any
  other field) the client sent is dropped at the boundary. Ownership can
  never be forged.
- `reset` is privileged: players submitting it get `unauthorized`; only the
  server path `resetMatch(roomId)` (for the future host/vote policy) resets.

#### Room lifecycle (minimal — no matchmaking)

```
waiting  ──startMatch (2..4 seated)──▶  playing  ──match ends──▶  finished
   │                                       │                        │
   │ seats join/leave freely               │ roster frozen;         │ rematch =
   │                                       │ leavers vacate         │ resetMatch
   └── last player leaves → room removed ◀─┴── last player leaves ───┘
```

Starting a match creates the room's one `GameHost` from the **stable roster**
(occupied seats at start time) and starts its fixed 60 Hz loop. Room state
transitions are derived from the match state pushes — no room-side game
logic. Empty rooms are removed automatically (and sweepable via
`removeEmptyRooms()`).

#### GameHost (unchanged from the previous milestone)

- **Commands** — `submitCommand(raw: unknown)` runs the engine's total
  structural validator, then the engine's ownership/phase rules, and returns
  the machine-readable `CommandResult` (acknowledgement-ready). Malformed or
  hostile input is rejected as `invalid-command`; the host never crashes on
  wire input and never installs client state — clients can only ever send
  intents.
- **Fixed 60 Hz simulation** — `start()`/`stop()` drive a Node timer loop
  (`setInterval`, never the browser frame loop). Wall-clock time only decides
  HOW MANY ticks are due; every tick advances the simulation by exactly
  `CONFIG.simulation.fixedTimestepMs` (1000/60 ms), so jitter never leaks into
  the physics. After a stall the loop catches up at most a configurable number
  of fixed ticks and drops the rest (anti-spiral). `tick()` is exposed as the
  loop primitive — deterministic tests, replays and bots use it directly.
- **Snapshots** — the host subscribes to the engine and caches the latest
  `serializeGameState()` wire snapshot; `serializedState()` returns it and
  `onStateChange(cb)` pushes it on every change. Rooms forward these pushes
  to every seated session via `onRoomState(session, cb)` — the transport's
  broadcast hook.

The intended transport flow (already the shape of the code):

```
receive command (wire)  →  gameServer.submitCommand(session, cmd)   // identity from the session
                        →  host fixed ticks                        // 60 Hz, exactly 1000/60 ms
                        →  serializeGameState()                    // cached on every change
                        →  onRoomView(session, cb)                 // per-viewer projection → broadcast
```

#### WebSocket transport (protocol v1)

`createWebSocketTransport({ port, gameServer? })` starts a standalone `ws`
server; each connection becomes exactly one Session and the socket IS the
connection identity (the session token never leaves the server). The
transport is a pure translator — wire message → server API call, server
event → wire message — with no gameplay logic, no engine imports and no
game loop of its own.

Every message (both directions) carries `{ "protocolVersion": 1, "type": … }`.
Malformed JSON, arrays, null, primitives, unknown types, wrong versions and
strict-envelope violations are rejected with a clean `error` message; the
connection stays alive.

Client → server: `create_room` · `join_room {roomId}` · `leave_room` ·
`start_match` · `reconnect {token}` (seat recovery — see below) ·
`command {command}` (the command's `playerId` — and every unknown field — is
discarded; identity comes from the session's seat).

Server → client: `welcome {roomId, playerId, roomState, roster,
hostPlayerId, reconnectToken}` · `room_state {roomId, roomState, roster,
hostPlayerId}` · `snapshot {state}` (the engine's `GameStateSnapshot`,
projected for the receiving client's own pawn via `projectSnapshot` — the
same view model the single-player client renders) ·
`match_finished {winnerId}` · `error {code, message}`.

**Authorization (v1 policy, deliberately minimal):** the room creator is the
room host; only the host may start the match (others get `unauthorized`).
`reset` is not exposed over the wire at all — `resetMatch()` stays a
server-side operation until rematch authorization is designed.

**Seat recovery (reconnection).** Taking a seat (create/join) issues an
opaque, 256-bit **reconnect credential** for that seat, returned to that
player alone in their personal `welcome` — never in broadcasts, rosters,
snapshots or any shared state. When a connection dies unexpectedly, the
seat is **reserved** (occupied, reported `connected: false`, invisible to
joiners) for a configurable window — `reconnectReservationMs`, default
30 000 ms, on `createGameServer()` / `createWebSocketTransport()` — instead
of being released. Presenting the credential on a new connection
(`reconnect {token}`) reclaims the SAME seat: same session identity, same
playerId, same live match state — the server immediately pushes the current
snapshot and room state, and the credential invalidates any previous
connection for that session (a takeover: the old socket is closed without
touching the seat). Credentials are resolved through a SHA-256 digest map
(no plaintext store, no early-exit comparison) and are revoked the moment
their seat is gone. After the window expires, the normal leave rules apply
(seat freed/vacated, room removed if empty, match state untouched) and the
credential is dead. Every failure — unknown, malformed, stale, expired —
is the same indistinguishable `invalid-reconnect` error, so credentials
cannot be used to probe rooms. A deliberate server-side close
(`handle.close()` / transport teardown) bypasses the reservation and
disconnects cleanly. Starting a match while a seat is reserved is allowed
(occupied seats form the roster); a disconnected player simply stays
unconfirmed — the early all-confirmed end waits for every ALIVE player, but
the server's `resolveRound` (decision deadline) always resolves the round
regardless, and a previously-confirmed move still executes while its player
is disconnected. A real timed deadline is deliberately still out of scope
(planned as its own task).

**Backpressure:** snapshots are full-state and high-frequency, so a socket
whose outbound buffer exceeds the high-water mark (256 KiB default) simply
stops receiving snapshots until it drains — stale intermediates are dropped
and the next sent snapshot always carries the newest authoritative state.
Commands are never dropped, and a slow client can never affect the
simulation or other clients.

#### Browser network client (protocol v1)

`src/client/network/` is the browser's end of the wire — a thin,
**non-authoritative** view of the server:

| Module              | Responsibility                                              |
| ------------------- | ----------------------------------------------------------- |
| `types.ts`          | `NetworkClientState`, `WebSocketLike` (the DOM boundary), `ReconnectPolicy`. |
| `protocolClient.ts` | Pure message building/parsing for protocol v1 — the client's mirror of `src/server/protocol.ts` (each side owns its end; the client never imports server code, keeping it out of the bundle). |
| `websocketClient.ts`| `createNetworkClient()` — connection lifecycle, state handling, sending, reconnection. |
| `react.tsx`         | `NetworkProvider` (owns exactly ONE client per mount) + `useNetworkClient()` / `useNetworkState()` (`useSyncExternalStore`) + `defaultServerUrl()`. The only place networking meets React. |

- **State, not simulation.** `createNetworkClient({ url, socketFactory?, reconnect? })`
  exposes `getState()` + `subscribe()` — the exact `useSyncExternalStore`
  contract — over one immutable `NetworkClientState`:
  `status` (`disconnected / connecting / connected / reconnecting / closed`),
  `roomId`, `playerId`, `roomState`, `roster`, `hostPlayerId`, the latest
  **server snapshot**, `winnerId`, `lastError` and `reconnectAttempt`.
  Snapshots **replace** the previous state (no merging, no prediction, no
  interpolation, no engine calls, no second `GameState` type — the snapshot
  payload is the engine's own `GameStateSnapshot`, type-only imported).
- **Methods**: `connect()` / `close()` / `createRoom()` / `joinRoom(id)` /
  `leaveRoom()` / `startMatch()` / `submitCommand(intent)`. Commands are
  rebuilt from intent fields only — a `playerId` (or any extra field) a
  caller tries to attach is dropped **before the wire**, and `reset` is
  refused outright (it is not a client operation).
- **Seat recovery.** A seat-holding connection keeps the reconnect
  credential from its `welcome` (internal to the client — never part of
  `NetworkClientState`). On an unexpected drop the room/seat picture is
  KEPT (the server reserves the seat) and the bounded-backoff retry sends
  `reconnect {token}` instead of starting over; the status only becomes
  `connected` again when the server confirms with a `welcome` carrying the
  same seat back. A rejected credential (invalid/expired — the server's
  one indistinguishable answer) clears the room state honestly and returns
  the client to the lobby surface. Without a credential (older server, or
  the connection never held a seat) a drop is what it always was: a fresh
  session with the room state cleared. An explicit `close()` and a
  successful `leaveRoom()` both drop the credential. No room is ever
  created automatically, no second player ever appears, and nothing is
  sent while not connected.
- **Lifecycle safety**: per-socket identity guards ignore stale events, a
  double `connect()` never creates a second socket, malformed server
  messages surface as `lastError` instead of throwing, and no state changes
  after a permanent close.
- **Testability**: the native `WebSocket` sits behind the tiny `WebSocketLike`
  interface, so the whole core runs (and is tested) without a DOM — over fake
  sockets in unit tests, and over an in-memory socket pair into the REAL
  `createGameServer()` + `createTransportCore()` stack in the integration
  suite. Nothing in `src/game/` knows WebSockets exist.

#### The multiplayer lobby

`src/client/components/lobby/` is the UI over that client — the app's entry
screen (`App.tsx` boots into the lobby; the original single-player screen
lives on as its "practice solo" mode). It is a display layer only: every
room fact it shows — room id, your seat, the host, the roster, the room
state, the winner — is server-reported data; nothing is inferred from
client-local assumptions.

- **Initial screen**: Create Room, a Room ID input + Join Room, and the
  connection status badge (disconnected / connecting / connected /
  reconnecting), with a manual Reconnect affordance and a "practice solo"
  escape hatch. Actions are disabled unless the client is connected.
- **Waiting room**: the room ID (share it), "you are `pN`" with a Host chip
  when the server-reported host id equals your server-assigned seat, the
  seat roster (`n / 4`, empty seats shown as placeholders, mid-match
  leavers shown as disconnected), the room state badge, and the actions.
  The **Start Match** button exists only for the server-reported host;
  while awaiting the server's answer it shows "Starting…". Non-hosts see a
  waiting note instead — and the server still authorizes the start itself:
  an `unauthorized` rejection (or any other server error) is displayed as
  a normal, dismissible error banner, never bypassed or retried silently.
- **States**: waiting → starting (local pending feedback only) → playing →
  finished (winner from `match_finished`), plus every connection state and
  a full room (4/4 — a fifth joiner sees the server's `room-full` error).
- **Leave Room** calls the network client's `leaveRoom()` and returns to
  the initial screen — a view-level navigation only, because protocol v1
  does not acknowledge the leave to the leaver. The server stays
  authoritative: any later roster push (a fresh welcome / room_state)
  overrides the local view. A dropped connection keeps the room panel (the
  seat is server-reserved) with a connection hint; only a rejected/expired
  recovery clears it.
- **DOM boundary kept**: the lobby renders in jsdom component tests over
  the REAL network client (in-memory socket pairs into the real server
  stack, or scripted sockets for timing-sensitive states) — no real
  network, no canvas.

#### Multiplayer gameplay (authoritative rendering)

When the server reports `roomState === "playing"` (or `"finished"`), the
lobby hands the screen to `src/client/components/game/MultiplayerGame.tsx`.
The browser is strictly a **terminal**: it renders the server's
viewer-projected snapshots and sends player intents — nothing else.

- **Rendering** reuses the pure canvas `renderer.ts` (the same one the solo
  screen uses). Every pawn, position, the aim indicator, elimination tints
  and the active-player pulse come from the latest snapshot;
  `snapshot.localPawnId` IS the local player (the server's own projection —
  never computed from the roster). Snapshots **replace** the picture; with
  no new push, nothing changes (the GameHost broadcasts only on state
  changes, so idle phases cause zero rerenders through the existing
  external store — no second subscription system).
- **Input gating** (`localControl.ts`, a pure function over the snapshot):
  the local player may act only when the phase is `aiming`, they have a
  pawn, it is alive, and it has not yet locked in its move for the current
  round. Pointer position → world coordinates is an INPUT calculation; the
  aim/power/confirmLaunch intents then travel the wire and the server alone
  decides whether they succeed (`wrong-player` / `wrong-phase` /
  `already-confirmed` / … rejections come back as normal error banners).
  Power shows a local pending value for responsiveness that ANY fresh
  snapshot replaces with the authoritative one.
- **Round/result UI** (rail + badge + overlay) reads the snapshot:
  choosing/ready/resolving, alive/eliminated — no local timers, no round
  advancement, no winner calculation. The winner is the server's
  `match_finished` / finished-snapshot verdict (null = no-survivor draw).
- **Disconnects mid-match (seat recovery)**: the last authoritative
  snapshot stays visible under a "Connection lost — retrying" banner, input
  is refused and nothing simulates locally — but the screen STAYS, because
  the server reserves the seat. The automatic retry presents the reconnect
  credential and the same match resumes exactly where it was (same
  playerId, same round, snapshots flowing again, banner gone). If the
  credential is rejected or expired, the room state is cleared and the
  lobby takes over again. There is deliberately **no reset** —
  `resetMatch` is server-side only.
- **Solo untouched**: `SoloGame.tsx` keeps its local engine path; entering
  it unmounts the network provider entirely (solo never touches the wire).

### Remaining work (reconnection is in — hardening next)

Real authentication (replacing the interim session and reconnect
credentials), the timed server-side round decision deadline (the manual
`resolveRound` plumbing is in; without a timer a silent room waits
indefinitely — nothing auto-resolves yet), rematch/vote policy on top of
`resetMatch`,
purely-visual interpolation between snapshots, a production server entry
script (the `scripts/smoke-server.ts` dev helper is manual-test tooling,
not one), and rate limiting / abuse guards.

### The match model (N players)

- **Roster**: `createGame({ players })` spawns any number of pawns on a
  deterministic circle (seat `i` at angle `-π/2 + i·2π/N`; seat 0 is the
  classic top spawn). The default is exactly the old single-player match.
- **Phases**: `aiming → moving → aiming → … → finished`. Elimination is *not*
  a phase — it is a per-pawn flag. Any number of pawns can be eliminated
  during a single `moving` phase (a launch can knock several opponents out,
  and the mover can follow itself).
- **Simultaneous rounds**: every alive player chooses independently during
  the shared `aiming` phase (aim + power + `confirmLaunch`). Confirming
  LOCKS that player's choice (further aim/setPower/confirm are rejected
  with `already-confirmed`) but moves nobody by itself. When ALL alive
  players have confirmed — or when the server submits the match-level
  `resolveRound` command (the decision deadline) — every confirmed pawn's
  impulse is applied in ONE transition and the physics resolves all of them
  together (confirmed movers can collide mid-flight). Unconfirmed pawns
  simply stay where they are. There is no turn queue, no active pawn and no
  rotation anywhere in the model. A single-pawn match is the degenerate
  case: the lone player's confirmation completes the set, so movement
  starts immediately (the classic solo flow, unchanged).
- **Finishing**: with nobody left the match ends immediately with **no
  winner**; in a multi-pawn roster the last pawn standing **wins** when the
  current round resolves (the mover may still take itself out, leaving no
  winner). A single-pawn match never finishes on its own — the lone pawn just
  aims again.
- **Eliminated pawns become ghosts**: frozen, non-collidable, but still part
  of the historical state (rendered where they left the arena). `reset`
  restores the whole roster.
- **Per-pawn controls**: each pawn carries its own aim + power + confirmed
  flag; power persists across rounds, aim and confirmation reset per round,
  and the aim is consumed by the pawn's own launch. The projection always
  exposes the VIEWER'S OWN controls (a spectator projection shows neutral
  defaults) — every player's screen describes their own choice, never
  "the active pawn's".

### Multiplayer readiness (server-authoritative; reconnection built in, real auth pending)

The engine already follows the intended server-authoritative flow:

```
command (player intent + playerId) → validateCommand → engine.applyCommand
  → engine.update (fixed 60 Hz ticks) → engine.getState()
  → serializeGameState (JSON) → WebSocket transport → network client state
  → deserializeGameState → engine.loadState → projectSnapshot → render
```

- **Commands are intentions only.** There is no command to eliminate a pawn,
  change the phase, resolve a collision, or declare a winner — those outcomes
  are computed exclusively inside the engine.
- **Command ownership**: every action command names its `playerId`; the
  engine rejects commands from unknown players (`unknown-player`),
  eliminated players (`wrong-player`), players who already locked in their
  move for the current round (`already-confirmed`), and any command in the
  wrong phase (`wrong-phase`). `resolveRound` and `reset` are match-level
  commands with no playerId — the server submits them through its own
  privileged path and the room manager rejects them on the player wire as
  `unauthorized`. A future server performs the same check after
  authenticating the session behind the `playerId` — client pawn ids are
  never trusted.
- **The engine has no local player.** `snapshot()` is a spectator projection
  (`localPawnId: null`); `subscribe()` pushes the raw authoritative
  `GameState`. Local perspective is attached by whoever renders
  (`projectSnapshot(state, myPawnId)`) — the client's `useGame.ts` does this
  with its own `LOCAL_PLAYER_ID`, which is exactly where a future session
  handshake will plug in.
- **The engine is a sealed package.** All client code imports it through the
  public barrel `src/game/index.ts` (enforced by tests — no deep imports into
  engine internals), so swapping the local orchestrator for a remote one
  changes one integration point, not every module.
- **`GameState` is plain JSON data** (no Matter.js internals, no functions)
  and contains everything needed to reconstruct a match, including
  mid-flight kinematics and per-pawn aim/power/confirmation;
  reconstruction continues deterministically. At every round boundary pawns
  are brought to a canonical resting state (stopped, no rim overlap), which
  is what keeps
  reconstruction bit-identical even after wall contacts.
- **Ownership**: the server (`src/server/`) validates and applies commands
  with the session's seat identity, simulates on a fixed clock, and exposes
  serialized states for broadcasting; clients only send commands and render
  snapshots. `useGame.ts` remains the single client integration point.

### Extension points for multiplayer

- **More pawns**: `createGame({ players: [...] })` or `engine.loadState()`
  with a multi-pawn state — simultaneous rounds, elimination, finishing and
  winner detection are all in place (see `__tests__/match.test.ts`).
- **Round deadline**: the server-side decision timer plugs into the existing
  `resolveRound` privileged path (roomManager/gameServer facade) — submit it
  when the round's deadline expires and the round resolves with whatever
  confirmations exist.
- **Bots**: bots only need to produce the same `GameCommand`s (a playerId +
  aim + power + confirm) — reusing `aiming.ts` helpers.
- **Server authority**: implemented headless — `createGameServer()` issues
  sessions, manages rooms (each owning one `createGameHost()`), stamps every
  command with the session's seat, steps `game.update()` on a fixed 60 Hz
  clock, and broadcasts `serializeGameState()` snapshots. The transport,
  the WebSocket glue and seat-recovery/reconnection policy are in; what is
  left: real authentication, the timed round deadline, and the rest of the
  hardening list above.

## Controls

1. Move the mouse to aim (a dashed arrow shows the direction; its length,
   opacity and chevron count grow with the selected power).
2. Pick a power level **1–5** (higher = stronger launch).
3. Click **Launch** to lock in your move — one launch per round (in
   multiplayer the round resolves once everyone has locked in, or at the
   server's round deadline; solo starts immediately).
4. The pawn slides with friction. The rim is a low lip: slow or glancing
   contacts bounce off it, but a fast head-on launch clears it — and once the
   pawn has completely left the floor it is **knocked out** and the match is
   over (in this single-player client there is no survivor, so no winner).
5. Click **Reset** (or **Play again**) to restore the full roster.

> Tuning notes (see `config.ts`): power 1 is a gentle nudge, power 5 is clearly
> stronger but not overpowering — momentum and prediction matter. Launching
> hard directly at the rim knocks you out, while glancing angles bounce off.

## Run it

```bash
npm install
npm run dev       # local dev (boots into the multiplayer lobby; "practice solo" runs the engine locally)
npm test          # full suite: engine + server + transport + lobby + multiplayer UI (Vitest)
npm run build     # typecheck + production build (single-file dist/index.html)
npm run smoke     # build + serve the app AND a real protocol-v1 game server on one port (manual testing)
```

The app boots into the lobby and connects to its own origin by default;
`?server=ws://host:port` points it at a standalone game server instead.
The multiplayer server is a library for now: `createWebSocketTransport()`
(from `src/server`) starts the protocol-v1 server on a port of your choice —
there is no long-running server entry script yet, by design. With no server
reachable, the lobby honestly shows Disconnected (with a Reconnect action)
and solo practice stays available.

## Manual multiplayer smoke test

`npm run smoke` builds the app and serves it together with a REAL
protocol-v1 game server (`createGameServer` + `createTransportCore` + the
engine's GameHost — see `scripts/smoke-server.ts`) on one port, so the
browser's default same-origin server URL just works. Then:

1. Open `http://localhost:4173` in two browser windows (A and B).
2. A: **Create Room** → the room ID is shown.
3. B: type that room ID → **Join Room**.
4. Both windows show the same roster (A is `p0` + Host, B is `p1`).
5. A: **Start Match** → both windows switch to the multiplayer game screen.
6. BOTH windows (simultaneous round): move the mouse over the arena →
   each side's own aim indicator follows (authoritative snapshots echo
   each player's own aim).
7. A: pick a power (1–5) → the readout follows. B does the same,
   independently — both control bars are live at the same time.
8. A: **Launch** → A's choice is LOCKED (badge "Ready — waiting for other
   players…", A's controls disabled) but nobody moves yet.
9. B: aim + power + **Launch** → the round resolves: BOTH pawns start
   moving together in both windows (phase "Round resolving…").
10. After everything settles a fresh round opens for the survivors
    ("Choose your move — aim!" again; unconfirmed players never moved).
11. Knock a pawn out of the arena → both windows mark it **Out**.
12. The match finishes → both windows show the same winner overlay.
13. **Back to lobby** returns to the initial screen on each side.
14. **Practice solo** still runs the fully local single-player game.

Seat recovery (optional, uses the same server):

15. A and B reach a running match (steps 1–5, a few rounds in).
16. In window B, close the TAB (or kill the network) → A's roster shows
    B **disconnected**; B's screen (if only the socket died) keeps the
    match under a "Connection lost — retrying" banner.
17. Reopen the page (or restore the network) → B reconnects
    automatically with its credential and lands back in the SAME seat,
    same match, same round — the roster shows B connected again and
    B's controls work right away (rounds are open to every alive player).
    A previously-confirmed move even survives the disconnect: it still
    executes when the round resolves. No new player appears.
18. To watch the expiry path instead: set `RECONNECT_RESERVATION_MS=5000`
    before `npm run smoke`, drop B, and wait >5 s before reconnecting —
    the credential is then rejected (`invalid-reconnect`), B returns to
    the lobby home, and B's old seat is claimable per the normal rules.

Automated equivalents: `multiplayerIntegration.test.tsx` (the whole loop
through the real server, engine and UI), `multiplayerGame.test.tsx`
(the screen's behavior over scripted sockets) and
`multiplayerReconnect.test.tsx` (the drop/recover/expire flows through
the real stack and UI).

## Tests

The engine regression suite lives in `src/game/__tests__/` and runs with
**Vitest** in a **node environment** — no DOM. Covered: pure-function math
(arena, aiming, round logic, config, players), the Matter.js facade (physics,
incl. ghosts and canonical rest), full game-orchestrator behavior — phases,
launch/round rules, movement/friction/settling, geometric elimination, rim
pass-over, reset, determinism, and frame-rate independence (identical
trajectories at 30/60/120/144 Hz) — and, in `match.test.ts`, whole
**N-player simultaneous-round matches** (the required spec suite: both
players choosing before any movement, a single confirmation never moving
anyone, the last confirmation resolving everyone together, four players
confirming independently, the deadline moving only the confirmed, confirmed
movements starting in one simulation transition, no turn/current-player
concept anywhere in the authoritative model, one player's commands never
touching another's intent, physical knockouts, self-elimination, winner/
no-winner detection, loadState normalization, serialization/replay
determinism, and per-viewer projection).

Three suites guard the **package boundary** itself:

- `src/game/__tests__/dom-free.test.ts` — every engine module is DOM-free,
  imports no React, and is fully self-contained: engine code may only import
  sibling modules and `matter-js`. The engine directory contains no client
  modules at all (`useGame.ts`/`renderer.ts` live in `src/client`).
- `src/game/__tests__/api.test.ts` — the public barrel exposes **exactly** the
  intended runtime exports (pinned as a sorted list) plus a compile-time
  canary for the type-only exports (`npm run build` runs `tsc` first).
- `src/client/__tests__/client-boundary.test.ts` — client files may import
  the engine only as the barrel (`../game`), never deep engine modules, and
  may **never import `src/server`** (server code must stay out of the browser
  bundle; only Node-side client tests, which live in `__tests__/`, may cross
  that line).

The **server** has its own suites in `src/server/__tests__/`:

- `gameHost.test.ts` — lifecycle (start/stop/destroy, idempotency), the
  fixed-timestep loop (each tick provably advances exactly
  `fixedTimestepMs` — host state stays bit-identical to a raw engine replica
  fed the same fixed ticks, even under real-time jitter and catch-up after a
  missed wakeup), command handling through the host only (unknown-player,
  wrong-player/already-confirmed, malformed/hostile input that never
  crashes, client state payloads rejected), snapshot exposure/broadcast
  semantics, reset, whole 2/3/4-player matches to a winner (rounds resolved
  at the decision deadline), and deterministic replay from the command log
  on both a fresh host and a raw engine.
- `server-boundary.test.ts` — the server package is DOM-free, imports no
  React/client code, reaches the engine only via its barrel (never
  `matter-js` directly), and is networked ONLY in the transport adapter
  (plain `ws`; the gameplay-bearing modules — session, GameHost,
  RoomManager, GameServer — stay transport-free). Additionally: the
  room/session modules drive gameplay only through `GameHost` (never
  `createGame`/matter-js directly), the transport talks only to server
  APIs (never the engine), the engine remains unaware of
  rooms/sessions/server/WebSockets, and GameHost remains transport-neutral.
- `roomManager.test.ts` — driven entirely through the `createGameServer()`
  facade, the way the future transport will: session issuance and
  disconnect, the identity chain (session → room → server-assigned
  p0/p1/p2/p3 by join order, lowest free seat, fifth player rejected),
  command ownership (commands applied with the session's identity; forged
  `playerId`s and unknown fields stripped; malformed input never crashes),
  room lifecycle (waiting → playing → finished via the real 60 Hz loop,
  stable roster at start, joins blocked once playing, mid-match leaves
  vacate seats, empty-room cleanup), privileged reset (players rejected as
  `unauthorized`, server path works), the round/disconnect semantics
  (`resolveRound` privileged — a disconnected unconfirmed player never
  blocks the round, a disconnected player's confirmed move still executes,
  an unconfirmed disconnected player does not move), independent
  simultaneous rooms, and
  the `onRoomState` broadcast hook.
- `transport.test.ts` — the wire protocol and connection logic over FAKE
  sockets (the same `createTransportCore` the real server runs):
  connection/session lifecycle and idempotent cleanup, full protocol
  validation (versions, malformed JSON/arrays/null/primitives, unknown
  types, strict envelopes), room operations, seat assignment and forged
  playerIds, command routing with engine rejections passed through,
  viewer-projected snapshot broadcasts (room-isolated), host-only start
  authorization, disconnect handling (a drop RESERVES the seat — reported
  disconnected, room alive — while a force-close releases it; a mid-flight
  drop still resolves the match), and the backpressure policy (drops for
  backed-up sockets, newest state on drain, no blocking of healthy
  members).
- `transport.e2e.test.ts` — the same flows over REAL `ws` sockets on an
  ephemeral port: real connections become sessions, the full
  create/join/start/command/snapshot round trip with per-viewer
  projection, malformed wire input never dropping the connection,
  disconnect notifications (a drop reserves the seat; the session is
  removed when the window expires), a whole match to `match_finished`
  over the wire, and clean transport teardown.
- `reconnect.test.ts` — seat recovery at the `createGameServer()` facade:
  credentials issued with every seat (opaque, never in room info),
  reservation semantics (occupied + disconnected + unstealable, identity
  preserved), recovery of the creator's and a joiner's seat, recovery
  mid-match (same playerId, same live state — nothing restarts), on the
  dropped player's own round (reconnect before resolution → the same round
  continues, the player can still choose; reconnect after resolution → the
  authoritative post-resolution state with a fresh round), after elimination (still
  eliminated), concurrent same-credential reconnects (no duplicate seats),
  uniform `invalid-reconnect` rejection for garbage/foreign/expired
  credentials, revocation on leave/disconnect/teardown, and expiry
  applying the normal leave rules (seat freed/vacated, empty rooms
  removed, reserved rooms surviving the window, re-reserve restarting it).
- `reconnect.transport.test.ts` — seat recovery over the WIRE (fake
  sockets through the real `createTransportCore`): the credential in
  create/join welcomes and nowhere else on the wire, drop → reserved
  roster → recovery with the same identity and the peer seeing them back,
  an immediate snapshot push on mid-match reconnect (projected for the
  recovered seat), connection takeover (a valid credential closes the old
  live socket without reserving or disconnecting the session), clean
  `invalid-reconnect` errors that leave the connection usable, expiry
  releasing the seat, the already-in-room guard, strict-envelope
  rejection of malformed reconnect messages, and reserved seats being
  invisible to joiners.

The **browser network client** has its own suites in
`src/client/network/__tests__/` (no DOM, no real server needed):

- `protocolClient.test.ts` — pure protocol: every builder envelope exact,
  command payloads rebuilt from intent fields only (forged `playerId`s and
  extras dropped, `reset` refused, hostile getters never throw), and the
  total parser: every server message shape accepted, malformed
  JSON/null/arrays/primitives, wrong protocol versions, unknown types and
  malformed payloads all rejected without throwing.
- `websocketClient.test.ts` — lifecycle and state over FAKE WebSockets:
  connect/duplicate-connect/close idempotency, explicit close never
  reconnecting, unexpected drop without a credential → `reconnecting`
  with the seat honestly cleared, bounded attempts when the server stays
  unreachable, and the full seat-recovery path (credential stored from
  the welcome, room state kept through the drop, the reconnect handshake
  as the retry's first message, recovery welcome restoring the same seat,
  a rejected credential clearing the seat and the connection staying
  usable, `leaveRoom`/`close` dropping the credential), every inbound
  message's state effect
  (welcome/room_state/snapshot-replacement/match_finished/error/malformed),
  all five senders wire-exact, commands blocked while not connected, no
  state mutation after permanent close, stale-socket events ignored, and
  the external-store contract (exactly-once notification, unsubscribe,
  referential stability, a broken subscriber cannot break the client).
- `integration.test.ts` — the full loop through an in-memory socket pair
  into the REAL server stack (`createTransportCore` + `createGameServer` +
  the engine): create/join/start with per-viewer projected snapshots,
  forged-`playerId` commands applied to the sender's own pawn, non-host
  start rejected as `unauthorized`, a whole physical match to
  `match_finished`, unknown-room errors surfaced without breaking the
  connection, an unexpected drop recovering the SAME seat via the
  credential (no duplicate seats, handshake on the wire, connection
  usable again), mid-match drop recovery with the match continuing,
  an expired credential rejected with the client back at the lobby
  surface, an explicit client close reserving the seat until the window
  expires, and subscriber notifications through it all.

The **lobby UI** has jsdom component suites in `src/client/__tests__/`
(`.test.tsx` files that opt into the jsdom environment via a docblock —
every other suite stays headless/node; dev-only deps:
`jsdom`, `@testing-library/react`, `@testing-library/dom`,
`@testing-library/jest-dom`):

- `lobby.test.tsx` — the initial screen: disconnected/connecting/reconnected
  states (badge + disabled actions + manual Reconnect), connected-but-not-
  in-room, create room (exact wire envelope + server-reported room/seat),
  join room by typed id, empty-id guard, a server error shown normally and
  dismissibly (unknown room), the practice-solo escape hatch, and an
  unexpected drop → Reconnecting… → successful reconnect as a fresh
  session.
- `lobbyRoom.test.tsx` — the waiting room: roster rendering with empty
  seats (1/4 → 2/4, from server broadcasts), host identification (Host/You
  chips from server-reported ids), the host-only Start Match button
  (non-hosts get a waiting note instead), a tampered non-host start
  surfacing the server's `unauthorized` error, leave room (exact wire
  envelope + return to the initial screen) and the room telling the
  others, the "Starting…" pending state until the server answers, the
  waiting → playing transition through the real server, the full
  four-player room (4/4, no empty seats, fifth joiner rejected with
  `room-full`), and the finished state with the server-reported winner.
- `app.test.tsx` — the real app shell (nothing injected): boots into the
  lobby, fails cleanly when no WebSocket/server exists (Disconnected, no
  crash, actions disabled), switches to the original solo screen and back;
  solo mode still runs the local engine (aim → launch → moving), and a
  socket-counting environment proves solo mode tears the network down
  (entering it unmounts the provider; no further sockets appear).
- `multiplayerGame.test.tsx` — the game screen over SCRIPTED sockets:
  rendering (every pawn from the snapshot, `localPawnId` taken from the
  server's projection — the You chip is where the server says it is,
  eliminated pawns rendered Out, new snapshots replace the picture and
  without a push nothing changes — no client physics), round ownership
  (controls enabled while the local player is choosing; disabled once they
  have locked in — but NOT when other players lock in / while the round
  resolves / when finished / when the local pawn is
  eliminated), commands (exact aim/setPower/confirmLaunch wire envelopes,
  pending power replaced by the authoritative value, nothing sent while
  disconnected or in invalid phases, server rejections displayed
  normally), match completion (winner from the snapshot, match_finished,
  null winner = no-survivor draw, Back-to-lobby leaves the room), the
  mid-match disconnect behavior (last snapshot visible, input refused,
  reconnect offered, nothing simulated), and the lobby → game screen
  transition on the server's playing state.
- `multiplayerIntegration.test.tsx` — the FULL loop with nothing faked:
  real GameServer + GameHost + engine + transport core + the real
  network client + the real React UI, two clients, one match. Proves
  player command → server engine → authoritative snapshot → client
  rendering state, identical snapshots on both clients (per-viewer
  projection aside), the required simultaneous-round proof (two players
  choose independently; one confirmation alone moves nobody; completing
  the set resolves BOTH movements in the same round; a fresh round opens
  after the settle), an elimination at the decision deadline, an identical
  winner verdict for both, and that the client's snapshot is untouched
  while the server is idle (no local simulation).
- `multiplayerReconnect.test.tsx` — seat recovery through the real stack
  AND the real UI: a mid-match drop keeps the game screen (banner, last
  snapshot, no lobby takeover) and the automatic retry recovers the same
  seat (same room/playerId, banner gone, commands flowing again, the peer
  seeing the seat disconnected → connected, no duplicates); a waiting-room
  drop keeps the room panel (Start disabled, a third player cannot steal
  the reserved seat) and recovery restores host + roster; an expired
  credential returns the player to the lobby home with the server's error
  shown, the room gone, and an immediate fresh start possible.
- `client-boundary.test.ts` (engine part) now resolves import targets
  instead of matching strings, so the client's `components/game/` folder
  is correctly recognized as client code while deep engine imports
  (e.g. `../../game/state`) are still rejected — the barrel rule is
  unchanged.
