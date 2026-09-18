// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { MatchRail } from "../components/game/MatchRail";
import { CONFIG, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import {
  connectPlayer,
  createScriptedClient,
  createServerHarness,
  renderLobby,
  wire,
} from "./lobbyTestHarness";

/**
 * A ROUND OF UI POLISH, pinned so it cannot quietly regress.
 *
 * Six requests, each one about removing noise or answering a question
 * the screen was leaving unanswered:
 *
 *   1. a rail tile is ONE LINE — name, colour, You. Nothing else.
 *   2. no "Connected" badge during a match (the arena is the proof that
 *      the connection works; a banner already covers the failure case).
 *   3. "(required)" appears only once a play attempt has been refused.
 *   4. Join Room turns green the moment a complete code is typed.
 *   5. the logo is bigger.
 *   6. the "Multiplayer match" subtitle under the logo becomes a proper
 *      heading over the roster, and says "Private game" for a private
 *      room — the one place the distinction actually matters to you.
 *
 * The rail-shape rules themselves live in matchLayoutColumn.test.tsx;
 * this file covers the whole-screen consequences and the lobby half.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(cleanup);

// ── rail fixtures (component-level) ─────────────────────────────────────

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

function pawn(
  id: string,
  name: string,
  extra: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name,
    position: { x: CX, y: CY },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    colorIndex: 0,
    isLocal: false,
    ...extra,
  };
}

function snap(pawns: readonly PawnSnapshot[]): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns,
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: { x: 1, y: 0 },
    isAiming: false,
    arenaRadius: CONFIG.arena.radius,
    roundNumber: 1,
    decisionDeadline: null,
    matchDeadline: null,
  } as unknown as GameStateSnapshot;
}

const duo = () => snap([pawn("p0", "Ada", { isLocal: true }), pawn("p1", "Bo")]);

// ── whole-screen fixtures ───────────────────────────────────────────────

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
  overrides: Record<string, unknown> = {}
) {
  await act(async () => {
    sockets[0].serverMessage(wire.snapshot(overrides));
  });
}

/** Put the client in a room of a known visibility, then start a match. */
async function enterRoom(
  sockets: ReturnType<typeof createScriptedClient>["sockets"],
  visibility: "public" | "private"
) {
  await act(async () => {
    sockets[0].serverMessage(
      JSON.stringify({
        protocolVersion: 1,
        type: "welcome",
        roomId: "r1",
        playerId: "p0",
        roomState: "playing",
        roster: [
          { playerId: "p0", connected: true },
          { playerId: "p1", connected: true },
        ],
        hostPlayerId: "p0",
        roomVisibility: visibility,
      })
    );
  });
}

// ── 2. the Connected badge is gone from the match ───────────────────────

describe("the match screen drops the connection badge", () => {
  it("shows no Connected badge while playing", async () => {
    const { sockets } = await renderGame();
    await feed(sockets);

    expect(screen.queryByTestId("connection-status")).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("still warns when the connection actually breaks", async () => {
    // Removing the everything-is-fine badge must not remove the
    // something-is-wrong one: that is the half that carries information.
    const { sockets } = await renderGame();
    await feed(sockets);
    await act(async () => {
      sockets[0].close(); // unexpected drop
    });

    expect(screen.getByTestId("connection-banner")).toBeInTheDocument();
  });
});

// ── 6. the roster heading replaces the subtitle ─────────────────────────

describe("the roster is titled by how you got into the room", () => {
  it("says Private game in a private room", async () => {
    const { sockets } = await renderGame();
    await enterRoom(sockets, "private");
    await feed(sockets);

    expect(screen.getByTestId("match-rail-title")).toHaveTextContent(
      "Private game"
    );
  });

  it("says Multiplayer match in a public room", async () => {
    const { sockets } = await renderGame();
    await enterRoom(sockets, "public");
    await feed(sockets);

    expect(screen.getByTestId("match-rail-title")).toHaveTextContent(
      "Multiplayer match"
    );
  });

  it("falls back to a neutral title when visibility is unknown", () => {
    // An older server, or a snapshot that arrives before the room state:
    // the heading must still name what the list is, never render blank.
    render(<MatchRail snapshot={duo()} />);
    const title = screen.getByTestId("match-rail-title");
    expect(title).toHaveTextContent("Players");
    expect(title.textContent?.trim()).not.toBe("");
  });

  it("is no longer a subtitle under the logo", async () => {
    const { sockets } = await renderGame();
    await enterRoom(sockets, "public");
    await feed(sockets);

    // Exactly one "Multiplayer match" on screen, and it is the roster
    // heading — not a second copy tucked under the wordmark.
    const hits = screen.getAllByText("Multiplayer match");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(screen.getByTestId("match-rail-title"));
  });

  it("heads the roster: the title precedes the tiles", async () => {
    const { sockets } = await renderGame();
    await enterRoom(sockets, "private");
    await feed(sockets);

    const rail = screen.getByTestId("match-rail");
    const title = screen.getByTestId("match-rail-title");
    const first = within(rail).getAllByTestId(/^rail-p/)[0];
    expect(title.compareDocumentPosition(first)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("is bigger than the player names it heads", async () => {
    // "Larger heading" was the request. jsdom has no layout engine, so
    // compare the Tailwind type scale: the tiles are text-xs (0.75rem),
    // the heading must be a step above.
    const { sockets } = await renderGame();
    await enterRoom(sockets, "private");
    await feed(sockets);

    const title = screen.getByTestId("match-rail-title");
    expect(title.className).toContain("text-sm");
    expect(title.className).not.toContain("text-xs");
    // ...and it is a real heading, not a styled div.
    expect(title.tagName).toBe("H2");
  });
});

// ── 3. "(required)" is a response, not a standing label ─────────────────

describe("the (required) marker waits for a refused attempt", () => {
  const renderHome = async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client, { playerName: "" });
    return player;
  };

  const clickQuickPlay = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /quick play/i }));
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  it("is absent on arrival", async () => {
    await renderHome();
    expect(screen.queryByTestId("name-required-tag")).toBeNull();
    // The label itself is still there — only the tag waits.
    expect(screen.getByTestId("player-name-input")).toHaveAccessibleName(
      expect.stringContaining("Player name:")
    );
  });

  it("appears after trying to play with an empty name", async () => {
    await renderHome();
    await clickQuickPlay();
    expect(screen.getByTestId("name-required-tag")).toBeInTheDocument();
  });

  it("appears alongside the spoken error, not instead of it", async () => {
    await renderHome();
    await clickQuickPlay();
    expect(screen.getByTestId("name-required-error")).toBeInTheDocument();
    expect(screen.getByTestId("name-required-tag")).toBeInTheDocument();
  });

  it("goes away once a name is typed", async () => {
    // The marker described a problem; the problem is solved, so the
    // marker leaves rather than nagging.
    await renderHome();
    await clickQuickPlay();
    expect(screen.getByTestId("name-required-tag")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByTestId("player-name-input"), {
        target: { value: "Ada" },
      });
    });
    expect(screen.queryByTestId("name-required-tag")).toBeNull();
  });

  it("never appears when the player names themselves first", async () => {
    // The happy path stays clean: nothing is ever flagged red at a
    // player who did it right.
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client, { playerName: "Ada" });

    await clickQuickPlay();
    expect(screen.queryByTestId("name-required-tag")).toBeNull();
  });
});

// ── 4. Join Room turns green on a complete code ─────────────────────────

describe("the Join Room button greens on a complete code", () => {
  const renderHome = async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client, { playerName: "Ada" });
    return player;
  };

  const type = async (value: string) => {
    await act(async () => {
      fireEvent.change(screen.getByTestId("room-code-input"), {
        target: { value },
      });
    });
  };

  const joinButton = () => screen.getByTestId("join-room");

  it("is neutral with an empty box", async () => {
    await renderHome();
    expect(joinButton()).toHaveAttribute("data-code-ready", "false");
    expect(joinButton().className).not.toContain("emerald");
  });

  it("stays neutral while the code is still incomplete", async () => {
    await renderHome();
    for (const partial of ["K", "K7", "K7P"]) {
      await type(partial);
      expect(joinButton()).toHaveAttribute("data-code-ready", "false");
      expect(joinButton().className).not.toContain("emerald");
    }
  });

  it("turns green on the fourth character", async () => {
    await renderHome();
    await type("K7P4");
    expect(joinButton()).toHaveAttribute("data-code-ready", "true");
    expect(joinButton().className).toContain("emerald");
  });

  it("goes back to neutral if a character is deleted", async () => {
    await renderHome();
    await type("K7P4");
    expect(joinButton()).toHaveAttribute("data-code-ready", "true");
    await type("K7P");
    expect(joinButton()).toHaveAttribute("data-code-ready", "false");
    expect(joinButton().className).not.toContain("emerald");
  });

  it("stays neutral for four characters that are not a valid code", async () => {
    // The alphabet excludes I, O, 0 and 1 precisely because they are
    // misread. Green must promise the code will be ACCEPTED, so a
    // four-character string containing them does not earn it.
    await renderHome();
    await type("K0P1");
    expect(joinButton()).toHaveAttribute("data-code-ready", "false");
    expect(joinButton().className).not.toContain("emerald");
  });

  it("greens a pasted code with stray whitespace", async () => {
    // Submission normalizes "k7 p4", so the button must agree with it —
    // otherwise green would lie about a code that actually works.
    await renderHome();
    await type("k7 p4");
    expect(joinButton()).toHaveAttribute("data-code-ready", "true");
    expect(joinButton().className).toContain("emerald");
  });

  it("green means clickable: the button is enabled", async () => {
    await renderHome();
    await type("K7P4");
    expect(joinButton()).toBeEnabled();
  });
});
