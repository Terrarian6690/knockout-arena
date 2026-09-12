// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG, type ArenaSnapshot, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { ArenaView } from "../components/game/ArenaView";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { NetworkProvider } from "../network/react";
import {
  ARENA_SIZE_LABELS,
  DESCRIPTION_PAWN_FIELDS,
  arenaSizeLabel,
  describeArenaState,
  describedPawn,
  descriptionKey,
  phaseDescription,
  seatDescription,
} from "../components/game/arenaDescription";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * ACCESSIBLE ARENA STATE DESCRIPTION (Task 12, first pass).
 *
 * The canvas carries facts that exist nowhere else in text: who is
 * still in, who is still deciding, how far the arena has closed in.
 * This suite pins the description that makes those readable.
 *
 * What it pins:
 *   - all six seats are described, occupied or empty, with the right
 *     name / alive status / host + you markers;
 *   - the arena size is QUALITATIVE (tiers), never a raw radius;
 *   - the text changes when the described state changes, and is left
 *     completely alone on ticks that only move pawns or change aim;
 *   - no private field (aim, power, launch, position) can appear;
 *   - reading or updating it never moves focus;
 *   - it is a description, NOT a live region — Tasks 9 and 10 own the
 *     event announcements and must not be duplicated here.
 */

const MAX = CONFIG.match.maxPlayers;
const INITIAL = CONFIG.arena.radius;
const STEP = CONFIG.arena.shrink.amount;
const MIN = CONFIG.arena.shrink.minRadius;

afterEach(() => {
  cleanup();
});

function pawn(slot: number, overrides: Partial<PawnSnapshot> = {}): PawnSnapshot {
  return {
    id: `p${slot}`,
    name: `Player ${slot + 1}`,
    position: { x: 100 + slot * 10, y: 100 },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: slot === 0,
    colorIndex: slot,
    ...overrides,
  };
}

function arena(radius: number = INITIAL): ArenaSnapshot {
  return {
    radius,
    roundsUntilShrink: radius <= MIN ? null : 2,
    nextRadius: radius <= MIN ? null : Math.max(MIN, radius - STEP),
    shrinkWarning: false,
    atMinRadius: radius <= MIN,
  };
}

function snapshot(overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: Array.from({ length: MAX }, (_, i) => pawn(i)),
    localPawnId: "p0",
    winnerId: null,
    roundNumber: 1,
    arena: arena(),
    power: CONFIG.power.default,
    aimDirection: null,
    isAiming: false,
    ...overrides,
  };
}

const describe_ = (
  s: GameStateSnapshot | null,
  hostPlayerId: string | null = "p0"
) => describeArenaState({ snapshot: s, hostPlayerId });

// ── seat coverage ────────────────────────────────────────────────────────

describe("the description lists every seat", () => {
  it("names all six players with their status", () => {
    const text = describe_(snapshot());
    for (let i = 0; i < MAX; i += 1) {
      expect(text).toContain(`Player ${i + 1}`);
    }
    expect(text).toContain("Player 1 (you, host): still in");
    expect(text).toContain("Player 2: still in");
  });

  it("marks eliminated players as knocked out", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { eliminated: i === 1 || i === 3 })
    );
    const text = describe_(snapshot({ pawns }));
    expect(text).toContain("Player 2: knocked out");
    expect(text).toContain("Player 4: knocked out");
    expect(text).toContain("Player 3: still in");
    expect(text).toContain("4 of 6 players still in.");
  });

  it("reports unoccupied seats as empty", () => {
    const pawns = [pawn(0), pawn(1)];
    const text = describe_(snapshot({ pawns }));
    expect(text).toContain("Player 1 (you, host): still in");
    expect(text).toContain("Player 2: still in");
    for (const seat of [3, 4, 5, 6]) {
      expect(text).toContain(`Seat ${seat}: empty`);
    }
    expect(text).toContain("2 of 2 players still in.");
  });

  it("uses custom display names when players set them", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { name: i === 2 ? "Zoë" : `Player ${i + 1}` })
    );
    expect(describe_(snapshot({ pawns }))).toContain("Zoë: still in");
  });

  it("marks the host even when the host is not the viewer", () => {
    const text = describe_(snapshot(), "p3");
    expect(text).toContain("Player 1 (you): still in");
    expect(text).toContain("Player 4 (host): still in");
  });

  it("builds a seat clause with the right markers", () => {
    const p0 = describedPawn(pawn(0));
    const p1 = describedPawn(pawn(1));
    const out = describedPawn(pawn(2, { eliminated: true }));
    expect(seatDescription(p0, "p0")).toBe("Player 1 (you, host): still in");
    expect(seatDescription(p1, "p0")).toBe("Player 2: still in");
    expect(seatDescription(p1, "p1")).toBe("Player 2 (host): still in");
    expect(seatDescription(out, "p0")).toBe("Player 3: knocked out");
  });

  it("copes with no host reported", () => {
    const text = describe_(snapshot(), null);
    expect(text).toContain("Player 1 (you): still in");
    expect(text).not.toContain("host");
  });

  it("says something sensible before the first snapshot", () => {
    expect(describe_(null)).toBe("Waiting for the match to start.");
  });
});

// ── qualitative arena size ───────────────────────────────────────────────

describe("arena size is described qualitatively", () => {
  it("maps each shrink step to its label", () => {
    expect(arenaSizeLabel(INITIAL)).toBe(ARENA_SIZE_LABELS.full);
    expect(arenaSizeLabel(INITIAL - STEP)).toBe(ARENA_SIZE_LABELS.shrunkOnce);
    expect(arenaSizeLabel(INITIAL - 2 * STEP)).toBe(ARENA_SIZE_LABELS.shrunkTwice);
    expect(arenaSizeLabel(INITIAL - 3 * STEP)).toBe("shrunk 3 times");
    expect(arenaSizeLabel(MIN)).toBe(ARENA_SIZE_LABELS.minimum);
  });

  it("covers the real schedule end to end", () => {
    // 330 → 290 → 250 → 210 → 180(min), per CONFIG.
    // Walk the schedule the way the SERVER does — each step clamps at
    // the minimum, so the last tier is exactly MIN (a raw `r -= STEP`
    // loop would stride past 180 to 170 and miss it).
    const labels: string[] = [];
    let r: number = INITIAL;
    labels.push(arenaSizeLabel(r));
    while (r > MIN) {
      r = Math.max(MIN, r - STEP);
      labels.push(arenaSizeLabel(r));
    }
    expect(labels).toEqual([
      "full size",
      "shrunk once",
      "shrunk twice",
      "shrunk 3 times",
      "minimum size",
    ]);
  });

  it("treats anything at or below the minimum as minimum size", () => {
    expect(arenaSizeLabel(MIN - 1)).toBe(ARENA_SIZE_LABELS.minimum);
    expect(arenaSizeLabel(0)).toBe(ARENA_SIZE_LABELS.minimum);
  });

  it("falls back to full size when the arena is absent or broken", () => {
    expect(arenaSizeLabel(undefined)).toBe(ARENA_SIZE_LABELS.full);
    expect(arenaSizeLabel(Number.NaN)).toBe(ARENA_SIZE_LABELS.full);
    expect(describe_(snapshot({ arena: undefined }))).toContain("Arena full size.");
  });

  it("never states a raw radius", () => {
    let r: number = INITIAL;
    for (;;) {
      const text = describe_(snapshot({ arena: arena(r) }));
      expect(text).not.toContain(String(r));
      expect(text).not.toMatch(/radius|pixel|px\b/i);
      if (r <= MIN) break;
      r = Math.max(MIN, r - STEP);
    }
  });
});

// ── phase ────────────────────────────────────────────────────────────────

describe("the description explains the current phase", () => {
  const pawns = (over: Partial<PawnSnapshot>[] = []) =>
    Array.from({ length: MAX }, (_, i) => pawn(i, over[i] ?? {})).map(describedPawn);

  it("describes the shared decision phase", () => {
    expect(phaseDescription("aiming", pawns())).toContain(
      "Players are choosing their moves"
    );
  });

  it("tells the viewer when their own move is outstanding", () => {
    expect(phaseDescription("aiming", pawns())).toContain("It is your move");
  });

  it("counts the remaining deciders once the viewer has locked in", () => {
    const text = phaseDescription("aiming", pawns([{ confirmed: true }]));
    expect(text).toContain("Waiting for 5 players.");
    expect(text).not.toContain("your move");
  });

  it("uses the singular for a single remaining player", () => {
    const over = Array.from({ length: MAX }, (_, i) =>
      i === 0 || i === 1 ? {} : { confirmed: true }
    );
    over[0] = { confirmed: true };
    expect(phaseDescription("aiming", pawns(over))).toContain(
      "Waiting for 1 player."
    );
  });

  it("says when everyone is ready", () => {
    const over = Array.from({ length: MAX }, () => ({ confirmed: true }));
    expect(phaseDescription("aiming", pawns(over))).toBe(
      "All players are ready; the round is about to resolve."
    );
  });

  it("describes resolution and match end", () => {
    expect(phaseDescription("moving", pawns())).toBe("The round is resolving.");
    expect(phaseDescription("finished", pawns())).toBe("The match is over.");
  });

  it("ignores eliminated players when counting deciders", () => {
    const over = Array.from({ length: MAX }, (_, i) =>
      i < 4 ? { eliminated: true } : {}
    );
    over[0] = { eliminated: true };
    const text = phaseDescription("aiming", pawns(over));
    expect(text).toContain("Waiting for 2 players.");
  });

  it("leads with the round number", () => {
    expect(describe_(snapshot({ roundNumber: 4 }))).toContain("Round 4.");
  });

  it("omits the round when the server did not send one", () => {
    const text = describe_(snapshot({ roundNumber: undefined }));
    expect(text).not.toContain("Round");
    expect(text).toContain("Arena full size.");
  });
});

// ── change detection ─────────────────────────────────────────────────────

describe("the description changes only when described state changes", () => {
  it("changes when a player is eliminated", () => {
    const before = snapshot();
    const after = snapshot({
      pawns: Array.from({ length: MAX }, (_, i) => pawn(i, { eliminated: i === 2 })),
    });
    expect(descriptionKey({ snapshot: before, hostPlayerId: "p0" })).not.toBe(
      descriptionKey({ snapshot: after, hostPlayerId: "p0" })
    );
    expect(describe_(after)).toContain("Player 3: knocked out");
  });

  it("changes when the phase changes", () => {
    expect(descriptionKey({ snapshot: snapshot(), hostPlayerId: "p0" })).not.toBe(
      descriptionKey({ snapshot: snapshot({ phase: "moving" }), hostPlayerId: "p0" })
    );
  });

  it("changes when the round advances", () => {
    expect(
      descriptionKey({ snapshot: snapshot({ roundNumber: 1 }), hostPlayerId: "p0" })
    ).not.toBe(
      descriptionKey({ snapshot: snapshot({ roundNumber: 2 }), hostPlayerId: "p0" })
    );
  });

  it("changes when the arena shrink tier changes", () => {
    expect(
      descriptionKey({ snapshot: snapshot({ arena: arena(INITIAL) }), hostPlayerId: "p0" })
    ).not.toBe(
      descriptionKey({
        snapshot: snapshot({ arena: arena(INITIAL - STEP) }),
        hostPlayerId: "p0",
      })
    );
  });

  it("changes when readiness changes", () => {
    const after = snapshot({
      pawns: Array.from({ length: MAX }, (_, i) => pawn(i, { confirmed: i === 0 })),
    });
    expect(descriptionKey({ snapshot: snapshot(), hostPlayerId: "p0" })).not.toBe(
      descriptionKey({ snapshot: after, hostPlayerId: "p0" })
    );
  });

  it("does NOT change when only pawn positions move", () => {
    const moved = snapshot({
      pawns: Array.from({ length: MAX }, (_, i) =>
        pawn(i, { position: { x: 400 + i, y: 222 }, velocity: { x: 9, y: -4 } })
      ),
    });
    expect(descriptionKey({ snapshot: moved, hostPlayerId: "p0" })).toBe(
      descriptionKey({ snapshot: snapshot(), hostPlayerId: "p0" })
    );
  });

  it("does NOT change when only aim or power changes", () => {
    const aimed = snapshot({
      aimDirection: { x: 0.6, y: -0.8 },
      isAiming: true,
      power: 5,
    });
    expect(descriptionKey({ snapshot: aimed, hostPlayerId: "p0" })).toBe(
      descriptionKey({ snapshot: snapshot(), hostPlayerId: "p0" })
    );
  });

  it("does NOT change when only deadlines tick", () => {
    const ticked = snapshot({
      roundDeadline: Date.now() + 1234,
      matchDeadline: Date.now() + 99_000,
    });
    expect(descriptionKey({ snapshot: ticked, hostPlayerId: "p0" })).toBe(
      descriptionKey({ snapshot: snapshot(), hostPlayerId: "p0" })
    );
  });

  it("does NOT change when the radius moves within one tier", () => {
    // Interpolated/intermediate radii must not churn the text.
    expect(
      descriptionKey({ snapshot: snapshot({ arena: arena(INITIAL) }), hostPlayerId: "p0" })
    ).toBe(
      descriptionKey({
        snapshot: snapshot({ arena: arena(INITIAL + 0.4) }),
        hostPlayerId: "p0",
      })
    );
  });
});

// ── privacy ──────────────────────────────────────────────────────────────

describe("the description never exposes private data", () => {
  it("narrows each pawn to the public allowlist", () => {
    const p = pawn(1, {
      launch: { direction: { x: 0.1, y: 0.9 }, power: 5 },
    });
    const out = describedPawn(p);
    expect(Object.keys(out).sort()).toEqual([...DESCRIPTION_PAWN_FIELDS].sort());
    const leaked = out as unknown as Record<string, unknown>;
    expect(leaked.launch).toBeUndefined();
    expect(leaked.position).toBeUndefined();
    expect(leaked.velocity).toBeUndefined();
  });

  it("cannot speak private values in any phase", () => {
    // Sentinel values everywhere private data lives; none may surface.
    for (const phase of ["aiming", "moving", "finished"] as const) {
      const s = snapshot({
        phase,
        power: 4242,
        aimDirection: { x: 0.123456, y: 0.987654 },
        isAiming: true,
        pawns: Array.from({ length: MAX }, (_, i) =>
          pawn(i, {
            position: { x: 4242, y: 4242 },
            velocity: { x: 4242, y: 4242 },
            launch: { direction: { x: 0.123456, y: 0.987654 }, power: 4242 },
          })
        ),
      });
      const text = describe_(s);
      expect(text).not.toContain("4242");
      expect(text).not.toContain("0.123456");
      expect(text).not.toContain("0.987654");
      expect(text).not.toMatch(/power|aim|direction|angle|velocity|launch/i);
    }
  });

  it("does not leak private data through the description key either", () => {
    // The key is not user-visible, but it is derived from the snapshot:
    // keeping it clean keeps the discipline honest.
    const key = descriptionKey({
      snapshot: snapshot({
        power: 4242,
        aimDirection: { x: 0.123456, y: 0 },
        pawns: Array.from({ length: MAX }, (_, i) =>
          pawn(i, { launch: { direction: { x: 1, y: 0 }, power: 4242 } })
        ),
      }),
      hostPlayerId: "p0",
    });
    expect(key).not.toContain("4242");
    expect(key).not.toContain("0.123456");
  });

  it("says only 'still in' or 'knocked out' about other players", () => {
    const text = describe_(
      snapshot({
        pawns: Array.from({ length: MAX }, (_, i) =>
          pawn(i, { confirmed: true, launch: { direction: { x: 1, y: 0 }, power: 5 } })
        ),
      })
    );
    // Readiness is public, but it is summarised in the phase sentence —
    // never attached to a named opponent as a per-player disclosure.
    expect(text).not.toMatch(/Player \d+ \(?[^:]*\)?: (ready|aiming|confirmed)/);
  });
});

// ── DOM behaviour ────────────────────────────────────────────────────────

describe("the description in the DOM", () => {
  function renderArena(s: GameStateSnapshot = snapshot(), host: string | null = "p0") {
    return render(
      <ArenaView snapshot={s} interactive onAim={() => {}} hostPlayerId={host} />
    );
  }

  const node = () => screen.getByTestId("arena-state-description");

  it("is associated with the canvas via aria-describedby", () => {
    renderArena();
    const canvas = screen.getByTestId("arena-canvas");
    const id = canvas.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toBe(node());
  });

  it("gives the canvas an accessible name and description", () => {
    renderArena();
    const canvas = screen.getByTestId("arena-canvas");
    expect(canvas).toHaveAttribute("role", "img");
    expect(canvas).toHaveAccessibleName("Arena");
    expect(canvas).toHaveAccessibleDescription(/Round 1\./);
  });

  it("is visually hidden but present in the accessibility tree", () => {
    renderArena();
    expect(node()).toHaveClass("sr-only");
    expect(node()).not.toHaveAttribute("aria-hidden");
    expect(node().textContent).toContain("Player 1");
  });

  it("is NOT a live region (Tasks 9/10 own the announcements)", () => {
    // A polite region here would re-read the whole roster on every
    // elimination, duplicating the Task 10 announcement.
    renderArena();
    expect(node()).not.toHaveAttribute("aria-live");
    expect(node()).not.toHaveAttribute("role");
    expect(node()).not.toHaveAttribute("aria-atomic");
  });

  it("updates when a player is eliminated", () => {
    const view = renderArena();
    expect(node().textContent).toContain("Player 3: still in");
    view.rerender(
      <ArenaView
        snapshot={snapshot({
          pawns: Array.from({ length: MAX }, (_, i) => pawn(i, { eliminated: i === 2 })),
        })}
        interactive
        onAim={() => {}}
        hostPlayerId="p0"
      />
    );
    expect(node().textContent).toContain("Player 3: knocked out");
  });

  it("updates when the arena shrink tier changes", () => {
    const view = renderArena();
    expect(node().textContent).toContain("Arena full size.");
    view.rerender(
      <ArenaView
        snapshot={snapshot({ arena: arena(INITIAL - STEP) })}
        interactive
        onAim={() => {}}
        hostPlayerId="p0"
      />
    );
    expect(node().textContent).toContain("Arena shrunk once.");
  });

  it("leaves the DOM text node untouched across irrelevant ticks", () => {
    // The real requirement: a moving pawn must not rewrite the text.
    const view = renderArena();
    const before = node();
    const beforeText = before.textContent;

    const mutations: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) mutations.push(r.type);
    });
    observer.observe(before, { childList: true, characterData: true, subtree: true });

    for (let i = 1; i <= 5; i += 1) {
      view.rerender(
        <ArenaView
          snapshot={snapshot({
            pawns: Array.from({ length: MAX }, (_, j) =>
              pawn(j, { position: { x: 300 + i * 7 + j, y: 200 + i } })
            ),
            aimDirection: { x: i / 10, y: 1 - i / 10 },
            power: ((i % 5) + 1),
          })}
          interactive
          onAim={() => {}}
          hostPlayerId="p0"
        />
      );
    }
    observer.disconnect();

    expect(mutations).toHaveLength(0);
    expect(node()).toBe(before);
    expect(node().textContent).toBe(beforeText);
  });

  it("does not move focus when it updates", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const view = renderArena();
    expect(outside).toHaveFocus();

    view.rerender(
      <ArenaView
        snapshot={snapshot({ phase: "moving", roundNumber: 3 })}
        interactive
        onAim={() => {}}
        hostPlayerId="p0"
      />
    );
    expect(node().textContent).toContain("The round is resolving.");
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("is not a tab stop", () => {
    renderArena();
    expect(node()).not.toHaveAttribute("tabindex");
    expect(node().querySelectorAll("button, a, input")).toHaveLength(0);
  });

  it("does not change on mouse movement over the canvas", () => {
    const onAim = vi.fn();
    render(
      <ArenaView snapshot={snapshot()} interactive onAim={onAim} hostPlayerId="p0" />
    );
    const text = node().textContent;
    fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
      clientX: 10,
      clientY: 20,
    });
    fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
      clientX: 300,
      clientY: 120,
    });
    expect(node().textContent).toBe(text);
  });
});

// ── through the real game screen ─────────────────────────────────────────

describe("the description in the real game screen", () => {
  async function renderGame() {
    const { client, sockets } = createScriptedClient();
    render(
      <NetworkProvider client={client}>
        <MultiplayerGame onLeave={() => client.leaveRoom()} />
      </NetworkProvider>
    );
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
    });
    return { client, sockets };
  }

  async function feed(
    sockets: ReturnType<typeof createScriptedClient>["sockets"],
    overrides: Record<string, unknown> = {},
    pawnOverrides: Record<string, Record<string, unknown>> = {}
  ) {
    await act(async () => {
      sockets[0].serverMessage(wire.snapshot(overrides, pawnOverrides));
    });
  }

  it("describes a live match from real server snapshots", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "aiming" }, { p0: { isLocal: true } });
    const text = screen.getByTestId("arena-state-description").textContent ?? "";
    expect(text).toContain("Player 1 (you)");
    expect(text).toMatch(/still in/);
    expect(text).not.toMatch(/power|aim/i);
  });

  it("tracks an elimination pushed by the server", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "aiming" }, { p0: { isLocal: true } });
    await feed(
      sockets,
      { phase: "aiming" },
      { p0: { isLocal: true }, p1: { eliminated: true } }
    );
    expect(screen.getByTestId("arena-state-description").textContent).toContain(
      "Player 2: knocked out"
    );
  });

  it("coexists with the Task 9 and Task 10 live regions", async () => {
    // Three distinct elements, each with its own job: the description
    // (no live semantics) plus the two announcers (polite regions).
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: "p0" }, { p0: { isLocal: true } });

    const description = screen.getByTestId("arena-state-description");
    const progress = screen.getByTestId("match-progress-announcement");
    const result = screen.getByTestId("match-result-announcement");

    expect(description).not.toBe(progress);
    expect(description).not.toBe(result);
    expect(progress).toHaveAttribute("aria-live", "polite");
    expect(result).toHaveAttribute("aria-live", "polite");
    expect(description).not.toHaveAttribute("aria-live");
    expect(description.textContent).toContain("The match is over.");
  });
});
