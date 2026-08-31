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
| `types.ts`      | Shared types & the `GameAction` union (UI → engine).      |
| `arena.ts`      | Circular arena model + boundary math (server-safe).       |
| `player.ts`     | Pawn model + color palette.                               |
| `aiming.ts`     | Aim direction + launch-velocity math.                     |
| `turnLogic.ts`  | Turn state machine + phase (aim → move → settle).    |
| `physics.ts`    | The *only* place that knows Matter.js (swap-friendly).    |
| `game.ts`       | Orchestrator: owns state, turns, and physics.             |
| `renderer.ts`   | Pure canvas drawing from a snapshot.                      |
| `useGame.ts`    | React hook bridging engine → UI + the RAF loop.           |

### Extension points for multiplayer

- **More pawns**: add entries to the `players` array in `game.ts`; turn order is
  already driven by `turnLogic.ts`'s queue.
- **Simultaneous turns**: `turnLogic.ts` documents where a "everyone aims, then
  everyone resolves" flag slots in.
- **Bots**: bots only need to produce the same `GameAction`s (an aim + power +
  confirm) — reusing `aiming.ts` helpers.
- **Server authority**: a network module would drive `game.dispatch()` from server
  messages and read `game.snapshot()` for state; `types.ts` shapes are already
  serializable and engine-agnostic.

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
npm run build     # production build (single-file dist/index.html)
```
