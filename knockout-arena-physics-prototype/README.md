# Knockout Arena

A browser-based 2D multiplayer game (currently a **single-player prototype on
an N-player-ready engine** — "Phase 1" of the multiplayer prep is done).

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
- **Vite** + **Tailwind CSS**

## Project structure (`src/game/`)

The engine is deliberately split from the React UI so multiplayer (rooms,
matchmaking, server-authoritative simulation, bots) can be added later without
rewriting the core.

There is exactly **one** game instance in the app: `App.tsx` creates it via
`useGame()` and passes the state down as props, so the canvas and the controls
always share the same game state.

| Module          | Responsibility                                            |
| --------------- | --------------------------------------------------------- |
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
| `renderer.ts`   | Pure canvas drawing from a snapshot.                      |
| `useGame.ts`    | React hook bridging engine → UI + the RAF loop; owns the client's local player id. |
| `index.ts`      | Public engine API surface (for a future headless server). |

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

### Multiplayer readiness (architecture only — no networking yet)

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
- **`GameState` is plain JSON data** (no Matter.js internals, no functions)
  and contains everything needed to reconstruct a match, including
  mid-flight kinematics and per-pawn aim/power; reconstruction continues
  deterministically. At every turn boundary pawns are brought to a canonical
  resting state (stopped, no rim overlap), which is what keeps
  reconstruction bit-identical even after wall contacts.
- **Ownership**: the future server validates and applies commands, simulates,
  and broadcasts states; clients only send commands and render snapshots.
  `useGame.ts` remains the single client integration point.

### Extension points for multiplayer

- **More pawns**: `createGame({ players: [...] })` or `engine.loadState()`
  with a multi-pawn state — rotation, elimination, finishing and winner
  detection are all in place (see `__tests__/match.test.ts`).
- **Simultaneous turns**: `turnLogic.ts` documents where a "everyone aims, then
  everyone resolves" flag slots in.
- **Bots**: bots only need to produce the same `GameCommand`s (a playerId +
  aim + power + confirm) — reusing `aiming.ts` helpers.
- **Server authority**: a network module would feed validated commands into
  `game.applyCommand()`, step `game.update()` on a fixed clock, and broadcast
  `serializeGameState(game.getState())`; clients `loadState()` and render.

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
npm run dev       # local dev
npm test          # engine test suite (Vitest, node environment)
npm run build     # typecheck + production build (single-file dist/index.html)
```

## Tests

The engine regression suite lives in `src/game/__tests__/` and runs with
**Vitest** in a **node environment** — no DOM — which doubles as a guard that
the engine stays headless (a `dom-free.test.ts` fails the build if any engine
module starts using browser APIs; `useGame.ts` is the only client-side module).
Covered: pure-function math (arena, aiming, turn logic, config, players), the
Matter.js facade (physics, incl. ghosts and canonical rest), full
game-orchestrator behavior — phases, launch/turn rules, movement/friction/
settling, geometric elimination, rim pass-over, reset, determinism, and
frame-rate independence (identical trajectories at 30/60/120/144 Hz) — and,
in `match.test.ts`, whole **N-player matches** (2/3/4-player rotation,
physical knockouts of non-active pawns, self-elimination, consecutive
eliminations, winner/no-winner detection, command ownership, per-pawn
aim/power, loadState normalization, serialization/replay determinism, and
per-viewer projection).
