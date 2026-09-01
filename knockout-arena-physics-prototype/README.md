# Knockout Arena

A browser-based 2D multiplayer game (currently a **single-player prototype on
an N-player-ready engine** — "Phase 1" (N-player engine), "Phase 2" (clean
engine↔client package boundary), "Phase 3" (headless authoritative server
host), "Phase 4" (rooms, sessions and the server-assigned identity chain)
and "Phase 5" (real-time WebSocket transport) of the multiplayer prep are
done).

## Overview

Played on a circular arena viewed from above. The player controls a pawn, aims
with the mouse, chooses a power level (1–5), and launches to knock opponents
out of the arena. The engine underneath is **player-count agnostic**: a match
is a roster of pawns (1..N), per-pawn aim/power, per-pawn elimination, a
deterministic turn rotation over the survivors, and a finished phase with a
winner. The shipped client plays a one-player match (the `"p0"` seat); no
networking yet.

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
| `turnLogic.ts`  | Turn state machine: full-roster queue + elimination-aware rotation. |
| `physics.ts`    | The *only* place that knows Matter.js (swap-friendly).    |
| `game.ts`       | Orchestrator: commands → fixed ticks → state; match lifecycle (elimination, finishing, winner). |

### Client (`src/client/`)

| Module                     | Responsibility                                       |
| -------------------------- | ---------------------------------------------------- |
| `useGame.ts`               | React hook bridging engine → UI + the RAF loop; owns the client's local player id. |
| `renderer.ts`              | Pure canvas drawing from a snapshot.                 |
| `App.tsx` / `main.tsx`     | App shell + Vite entry point.                        |
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
`start_match` · `command {command}` (the command's `playerId` — and every
unknown field — is discarded; identity comes from the session's seat).

Server → client: `welcome {roomId, playerId, roomState, roster, hostPlayerId}` ·
`room_state {roomId, roomState, roster, hostPlayerId}` ·
`snapshot {state}` (the engine's `GameStateSnapshot`, projected for the
receiving client's own pawn via `projectSnapshot` — the same view model the
single-player client renders) · `match_finished {winnerId}` ·
`error {code, message}`.

**Authorization (v1 policy, deliberately minimal):** the room creator is the
room host; only the host may start the match (others get `unauthorized`).
`reset` is not exposed over the wire at all — `resetMatch()` stays a
server-side operation until rematch authorization is designed.

**Backpressure:** snapshots are full-state and high-frequency, so a socket
whose outbound buffer exceeds the high-water mark (256 KiB default) simply
stops receiving snapshots until it drains — stale intermediates are dropped
and the next sent snapshot always carries the newest authoritative state.
Commands are never dropped, and a slow client can never affect the
simulation or other clients.

### Remaining work (transport now exists — auth and resilience next)

Real authentication (replacing the interim session token), reconnection
(reattaching a session to a vacated seat), disconnected-player turn
timeouts, rematch/vote policy on top of `resetMatch`, a browser client that
speaks protocol v1 (the shipped client still runs the engine locally), and
rate limiting / abuse guards.

### The match model (N players)

- **Roster**: `createGame({ players })` spawns any number of pawns on a
  deterministic circle (seat `i` at angle `-π/2 + i·2π/N`; seat 0 is the
  classic top spawn). The default is exactly the old single-player match.
- **Phases**: `aiming → moving → aiming → … → finished`. Elimination is *not*
  a phase — it is a per-pawn flag. Any number of pawns can be eliminated
  during a single `moving` phase (a launch can knock several opponents out,
  and the mover can follow itself).
- **Turn rotation**: the queue is the full, stable roster for the whole match
  (replay-friendly); rotation deterministically skips eliminated pawns.
- **Finishing**: with nobody left the match ends immediately with **no
  winner**; in a multi-pawn roster the last pawn standing **wins** when the
  current turn resolves (the mover may still take itself out, leaving no
  winner). A single-pawn match never finishes on its own — the lone pawn just
  aims again.
- **Eliminated pawns become ghosts**: frozen, non-collidable, but still part
  of the historical state (rendered where they left the arena). `reset`
  restores the whole roster.
- **Per-pawn controls**: each pawn carries its own aim + power selection;
  they persist across other players' turns and are consumed at launch. The UI
  always shows the *active* pawn's controls.

### Multiplayer readiness (server-authoritative; auth/reconnection pending)

The engine already follows the intended server-authoritative flow:

```
command (player intent + playerId) → validateCommand → engine.applyCommand
  → engine.update (fixed 60 Hz ticks) → engine.getState()
  → serializeGameState (JSON) → [future transport]
  → deserializeGameState → engine.loadState → projectSnapshot → render
```

- **Commands are intentions only.** There is no command to eliminate a pawn,
  change the phase, resolve a collision, or declare a winner — those outcomes
  are computed exclusively inside the engine.
- **Command ownership**: every action command names its `playerId`; the
  engine rejects commands from unknown players (`unknown-player`), eliminated
  players or out-of-turn players (`wrong-player`), and any command in the
  wrong phase (`wrong-phase`). A future server performs the same check after
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
  mid-flight kinematics and per-pawn aim/power; reconstruction continues
  deterministically. At every turn boundary pawns are brought to a canonical
  resting state (stopped, no rim overlap), which is what keeps
  reconstruction bit-identical even after wall contacts.
- **Ownership**: the server (`src/server/`) validates and applies commands
  with the session's seat identity, simulates on a fixed clock, and exposes
  serialized states for broadcasting; clients only send commands and render
  snapshots. `useGame.ts` remains the single client integration point.

### Extension points for multiplayer

- **More pawns**: `createGame({ players: [...] })` or `engine.loadState()`
  with a multi-pawn state — rotation, elimination, finishing and winner
  detection are all in place (see `__tests__/match.test.ts`).
- **Simultaneous turns**: `turnLogic.ts` documents where a "everyone aims, then
  everyone resolves" flag slots in.
- **Bots**: bots only need to produce the same `GameCommand`s (a playerId +
  aim + power + confirm) — reusing `aiming.ts` helpers.
- **Server authority**: implemented headless — `createGameServer()` issues
  sessions, manages rooms (each owning one `createGameHost()`), stamps every
  command with the session's seat, steps `game.update()` on a fixed 60 Hz
  clock, and broadcasts `serializeGameState()` snapshots. What is left for
  the transport milestone: the WebSocket glue, real authentication and
  reconnection policy.

## Controls

1. Move the mouse to aim (a dashed arrow shows the direction; its length,
   opacity and chevron count grow with the selected power).
2. Pick a power level **1–5** (higher = stronger launch).
3. Click **Launch** to apply the impulse — one launch per turn.
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
npm run dev       # local dev (single-player client — runs the engine locally)
npm test          # full suite: engine + server + transport (Vitest, node environment)
npm run build     # typecheck + production build (single-file dist/index.html)
```

The multiplayer server is a library for now: `createWebSocketTransport()`
(from `src/server`) starts the protocol-v1 server on a port of your choice —
there is no long-running server entry script yet, by design.

## Tests

The engine regression suite lives in `src/game/__tests__/` and runs with
**Vitest** in a **node environment** — no DOM. Covered: pure-function math
(arena, aiming, turn logic, config, players), the Matter.js facade (physics,
incl. ghosts and canonical rest), full game-orchestrator behavior — phases,
launch/turn rules, movement/friction/settling, geometric elimination, rim
pass-over, reset, determinism, and frame-rate independence (identical
trajectories at 30/60/120/144 Hz) — and, in `match.test.ts`, whole
**N-player matches** (2/3/4-player rotation, physical knockouts of non-active
pawns, self-elimination, consecutive eliminations, winner/no-winner
detection, command ownership, per-pawn aim/power, loadState normalization,
serialization/replay determinism, and per-viewer projection).

Three suites guard the **package boundary** itself:

- `src/game/__tests__/dom-free.test.ts` — every engine module is DOM-free,
  imports no React, and is fully self-contained: engine code may only import
  sibling modules and `matter-js`. The engine directory contains no client
  modules at all (`useGame.ts`/`renderer.ts` live in `src/client`).
- `src/game/__tests__/api.test.ts` — the public barrel exposes **exactly** the
  intended runtime exports (pinned as a sorted list) plus a compile-time
  canary for the type-only exports (`npm run build` runs `tsc` first).
- `src/client/__tests__/client-boundary.test.ts` — client files may import
  the engine only as the barrel (`../game`), never deep engine modules.

The **server** has its own suites in `src/server/__tests__/`:

- `gameHost.test.ts` — lifecycle (start/stop/destroy, idempotency), the
  fixed-timestep loop (each tick provably advances exactly
  `fixedTimestepMs` — host state stays bit-identical to a raw engine replica
  fed the same fixed ticks, even under real-time jitter and catch-up after a
  missed wakeup), command handling through the host only (unknown-player,
  wrong-player, malformed/hostile input that never crashes, client state
  payloads rejected), snapshot exposure/broadcast semantics, reset, whole
  2/3/4-player matches to a winner, and deterministic replay from the
  command log on both a fresh host and a raw engine.
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
  `unauthorized`, server path works), independent simultaneous rooms, and
  the `onRoomState` broadcast hook.
- `transport.test.ts` — the wire protocol and connection logic over FAKE
  sockets (the same `createTransportCore` the real server runs):
  connection/session lifecycle and idempotent cleanup, full protocol
  validation (versions, malformed JSON/arrays/null/primitives, unknown
  types, strict envelopes), room operations, seat assignment and forged
  playerIds, command routing with engine rejections passed through,
  viewer-projected snapshot broadcasts (room-isolated), host-only start
  authorization, disconnect handling (mid-flight disconnect still resolves
  the match), and the backpressure policy (drops for backed-up sockets,
  newest state on drain, no blocking of healthy members).
- `transport.e2e.test.ts` — the same flows over REAL `ws` sockets on an
  ephemeral port: real connections become sessions, the full
  create/join/start/command/snapshot round trip with per-viewer
  projection, malformed wire input never dropping the connection,
  disconnect notifications, a whole match to `match_finished` over the
  wire, and clean transport teardown.
