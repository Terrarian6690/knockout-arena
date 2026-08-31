# Knockout Arena

A browser-based 2D multiplayer game (currently a **single-player physics prototype** — "Phase 1").

## Overview

Played on a circular arena viewed from above. The player controls a pawn, aims
with the mouse, chooses a power level (1–5), and launches to knock opponents
out of the arena. Phase 1 implements one player, aiming, power selection,
momentum physics, knockout detection, elimination, and reset — no networking yet.

The simulation runs at a **fixed 60 Hz timestep** (the render loop exchanges
real frame time for fixed ticks), so physics behaves identically on any
display refresh rate. Elimination is a pure geometric rule: the pawn is out
when it has **completely left the playable floor** (arena geometry + pawn
radius — see `arena.ts`).

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
| `commands.ts`   | Player-intent commands + structural validation (network-safe). |
| `types.ts`      | Client-facing view types (snapshot contracts).            |
| `state.ts`      | Serializable authoritative `GameState` + validation + JSON boundary. |
| `project.ts`    | Pure projection `GameState` → `GameStateSnapshot`.        |
| `arena.ts`      | Circular arena model + boundary math (server-safe).       |
| `player.ts`     | Pawn model + color palette.                               |
| `aiming.ts`     | Aim direction + launch-velocity math.                     |
| `turnLogic.ts`  | Turn state machine + phase (aim → move → settle).         |
| `physics.ts`    | The *only* place that knows Matter.js (swap-friendly).    |
| `game.ts`       | Orchestrator: commands → fixed ticks → state/snapshots.   |
| `renderer.ts`   | Pure canvas drawing from a snapshot.                      |
| `useGame.ts`    | React hook bridging engine → UI + the RAF loop.           |
| `index.ts`      | Public engine API surface (for a future headless server). |

### Multiplayer readiness (architecture only — no networking yet)

The engine already follows the intended server-authoritative flow:

```
command (player intent) → validateCommand → engine.applyCommand
  → engine.update (fixed 60 Hz ticks) → engine.getState()
  → serializeGameState (JSON) → [future transport]
  → deserializeGameState → engine.loadState → projectSnapshot → render
```

- **Commands are intentions only.** There is no command to eliminate a pawn,
  change the phase, resolve a collision, or declare a winner — those outcomes
  are computed exclusively inside the engine.
- **`GameState` is plain JSON data** (no Matter.js internals, no functions)
  and contains everything needed to reconstruct a match, including
  mid-flight kinematics; reconstruction continues deterministically.
- **The engine is state-driven**: `loadState` can adopt arbitrary
  (validated) states, including multi-pawn ones — turn order already rotates.
- **Ownership**: the future server validates and applies commands, simulates,
  and broadcasts states; clients only send commands and render snapshots.
  `useGame.ts` remains the single client integration point.

### Extension points for multiplayer

- **More pawns**: the engine is state-driven — `engine.loadState()` accepts
  multi-pawn states and `turnLogic.ts`'s queue already rotates turn order.
- **Simultaneous turns**: `turnLogic.ts` documents where a "everyone aims, then
  everyone resolves" flag slots in.
- **Bots**: bots only need to produce the same `GameCommand`s (an aim + power +
  confirm) — reusing `aiming.ts` helpers.
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
   pawn has completely left the floor it is **knocked out**.
5. Click **Reset** to play again.

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
Matter.js facade (physics), and full game-orchestrator behavior — phases,
launch/turn rules, movement/friction/settling, geometric elimination, rim
pass-over, reset, determinism, and frame-rate independence (identical
trajectories at 30/60/120/144 Hz).
