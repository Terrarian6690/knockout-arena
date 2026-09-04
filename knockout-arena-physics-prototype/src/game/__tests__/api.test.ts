import { describe, expect, it } from "vitest";
import * as engine from "../index";
import type * as EngineApi from "../index";

/**
 * Public API contract for the engine package boundary.
 *
 * src/game/index.ts is the ONLY module consuming code (the React client, a
 * future authoritative server, bots, tooling) may import. These tests pin
 * that surface so it can only change deliberately:
 *
 *   - the runtime exports are exactly the intended list (no accidental
 *     re-exports of engine internals, Matter.js symbols or UI code);
 *   - the type-only exports are pinned by a compile-time canary below —
 *     removing any of them fails `tsc`, which `npm run build` runs first.
 *
 * If you are ADDING to the public API: extend the list here AND have a
 * consumer that actually needs it. Everything else stays internal.
 */

/** Every value (runtime) export of the engine entry point, sorted. */
const EXPECTED_RUNTIME_EXPORTS = [
  "CONFIG",
  "aimAt",
  "createArena",
  "createGame",
  "deserializeGameState",
  "floorRadius",
  "indicatorLength",
  "playerColor",
  "playerStroke",
  "projectSnapshot",
  "serializeGameState",
  "validateCommand",
  "validateGameState",
  "withPlayerId",
] as const;

describe("engine public API (src/game/index.ts)", () => {
  it("exposes exactly the intended runtime exports", () => {
    expect(Object.keys(engine).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS]);
  });

  it("does not leak engine internals, Matter.js or UI symbols", () => {
    const keys = Object.keys(engine);
    // Not exhaustive — the exact-list test above is the real guard; these
    // make failures readable when someone adds an unintended export.
    for (const forbidden of [
      "createPhysicsWorld", // physics facade is internal
      "createTurnState", // turn state machine is internal
      "createPlayer", // player construction goes through createGame/loadState
      "Engine", "Composite", "Bodies", // Matter.js internals
      "useGame", "render", "computeTransform", // client/UI code
    ]) {
      expect(keys, `must not export ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exports working engine functions", () => {
    expect(typeof engine.createGame).toBe("function");
    expect(typeof engine.validateCommand).toBe("function");
    expect(typeof engine.withPlayerId).toBe("function");
    expect(typeof engine.serializeGameState).toBe("function");
    expect(typeof engine.deserializeGameState).toBe("function");
    expect(typeof engine.validateGameState).toBe("function");
    expect(typeof engine.projectSnapshot).toBe("function");
    expect(typeof engine.createArena).toBe("function");
    expect(typeof engine.floorRadius).toBe("function");
    expect(typeof engine.playerColor).toBe("function");
    expect(typeof engine.playerStroke).toBe("function");
    expect(typeof engine.indicatorLength).toBe("function");
    expect(engine.CONFIG).toBeDefined();
  });

  it("boots and runs a headless match through the public API only", () => {
    // The exact call pattern a future server will use — no deep imports,
    // no DOM, no React, nothing but the barrel.
    const game = engine.createGame({
      players: [
        { id: "p0", name: "A" },
        { id: "p1", name: "B" },
      ],
    });
    const ok = game.applyCommand({
      type: "aim",
      playerId: "p0",
      x: 450,
      y: 350,
    });
    expect(ok).toEqual({ ok: true });
    game.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    while (game.getState().phase === "moving") game.update(1000 / 60);

    const wire = engine.serializeGameState(game.getState());
    const restored = engine.deserializeGameState(wire);
    expect(engine.validateGameState(restored)).toBe(restored);
    expect(engine.projectSnapshot(restored, null).pawns).toHaveLength(2);
    game.destroy();
  });

  it("type-only exports are pinned by this compile-time canary", () => {
    // UPDATED/NEW for the package boundary: type exports cannot be checked
    // at runtime, so this alias references every intended type-only export.
    // If one disappears from the barrel, `tsc` (run by `npm run build`)
    // fails on this line.
    type _intendedTypeExports = [
      EngineApi.GameCommand,
      EngineApi.PlayerIntent,
      EngineApi.CommandResult,
      EngineApi.CommandRejection,
      EngineApi.GameHandle,
      EngineApi.GameOptions,
      EngineApi.PlayerSpec,
      EngineApi.GameState,
      EngineApi.PawnState,
      EngineApi.PawnAimState,
      EngineApi.LaunchSelection,
      EngineApi.GamePhase,
      EngineApi.GameStateSnapshot,
      EngineApi.PawnSnapshot,
      EngineApi.Vec2,
      EngineApi.Arena,
    ];
    const _canary: _intendedTypeExports | undefined = undefined;
    expect(_canary).toBeUndefined();
  });
});
