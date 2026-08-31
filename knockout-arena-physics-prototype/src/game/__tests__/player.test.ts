import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  PLAYER_COLORS,
  PLAYER_STROKES,
  createPlayer,
  playerColor,
  playerStroke,
} from "../player";

describe("createPlayer", () => {
  it("creates a pawn from its input with the configured radius", () => {
    const p = createPlayer({
      id: "p0",
      name: "Player 1",
      colorIndex: 2,
      spawnX: 450,
      spawnY: 110,
    });
    expect(p.id).toBe("p0");
    expect(p.name).toBe("Player 1");
    expect(p.colorIndex).toBe(2);
    expect(p.radius).toBe(CONFIG.pawn.radius);
    expect(p.spawnX).toBe(450);
    expect(p.spawnY).toBe(110);
    expect(p.eliminated).toBe(false);
  });
});

describe("color palettes", () => {
  it("exposes as many strokes as fills (up to 6 players)", () => {
    expect(PLAYER_COLORS.length).toBeGreaterThanOrEqual(6);
    expect(PLAYER_STROKES.length).toBe(PLAYER_COLORS.length);
  });

  it("has distinct fill colors", () => {
    expect(new Set(PLAYER_COLORS).size).toBe(PLAYER_COLORS.length);
  });

  it("has distinct stroke colors", () => {
    expect(new Set(PLAYER_STROKES).size).toBe(PLAYER_STROKES.length);
  });
});

describe("playerColor / playerStroke", () => {
  it("return the palette entry for each index", () => {
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      expect(playerColor(i)).toBe(PLAYER_COLORS[i]);
      expect(playerStroke(i)).toBe(PLAYER_STROKES[i]);
    }
  });

  it("wrap around for indices beyond the palette (more players than colors)", () => {
    expect(playerColor(PLAYER_COLORS.length)).toBe(PLAYER_COLORS[0]);
    expect(playerStroke(PLAYER_STROKES.length)).toBe(PLAYER_STROKES[0]);
    expect(playerColor(2 * PLAYER_COLORS.length + 1)).toBe(PLAYER_COLORS[1]);
  });

  it("handle negative indices by wrapping from the end", () => {
    // JS modulo of negatives is negative; the helpers must stay in bounds.
    expect(playerColor(-1)).toBe(PLAYER_COLORS[PLAYER_COLORS.length - 1]);
    expect(playerStroke(-1)).toBe(PLAYER_STROKES[PLAYER_STROKES.length - 1]);
  });
});
