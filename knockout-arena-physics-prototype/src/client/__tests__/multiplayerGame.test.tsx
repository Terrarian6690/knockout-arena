// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { canLocalPlayerAct } from "../components/game/localControl";
import type { GameStateSnapshot } from "../../game";
import {
  createScriptedClient,
  renderLobby,
  wire,
} from "./lobbyTestHarness";

/**
 * Multiplayer game screen behavior over SCRIPTED sockets (the pure
 * client↔UI loop; the full server-driven loop — real engine, real
 * transport — is pinned in multiplayerIntegration.test.tsx).
 *
 * Everything here rests on one rule: the screen renders the server's
 * snapshot and sends intents; it never simulates anything.
 */

/** Render the game screen directly and feed it one snapshot. */
async function renderGame() {
  const { client, sockets } = createScriptedClient();
  // onLeave mirrors the Lobby's real wiring: leave the room over the wire.
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

/** Send one snapshot (act-wrapped) and return its parsed state. */
async function feed(
  sockets: ReturnType<typeof createScriptedClient>["sockets"],
  overrides: Record<string, unknown> = {},
  pawnOverrides: Record<string, Record<string, unknown>> = {}
): Promise<GameStateSnapshot> {
  const raw = wire.snapshot(overrides, pawnOverrides);
  await act(async () => {
    sockets[0].serverMessage(raw);
  });
  return JSON.parse(raw).state as GameStateSnapshot;
}

function pointerAim() {
  fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
    clientX: 120,
    clientY: 80,
  });
}

const sentCommands = (sockets: ReturnType<typeof createScriptedClient>["sockets"]) =>
  sockets[0].sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "command")
    .map((message) => message.command);

// ── rendering ────────────────────────────────────────────────────────────

describe("multiplayer game: rendering", () => {
  it("renders every pawn from the authoritative snapshot", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, {
      p0: {},
      p1: {},
    });
    // Default wire snapshot has 2 pawns; feed a 4-pawn room.
    const four = [
      { id: "p0", isLocal: true },
      { id: "p1" },
      { id: "p2" },
      { id: "p3" },
    ];
    await feed(sockets, { pawns: four });
    for (const id of ["p0", "p1", "p2", "p3"]) {
      expect(screen.getByTestId(`rail-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Player 3")).toBeInTheDocument();
    expect(screen.getByTestId("arena-canvas")).toBeInTheDocument();
  });

  it("takes localPawnId from the server snapshot (You chip on the server's choice)", async () => {
    const { sockets } = await renderGame();
    // The server says this viewer is p1 (isLocal on p1 only).
    await feed(
      sockets,
      { localPawnId: "p1" },
      { p0: { isLocal: false }, p1: { isLocal: true } }
    );
    expect(screen.getByTestId("rail-p1").textContent).toContain("You");
    expect(screen.getByTestId("rail-p0").textContent).not.toContain("You");
    // Round badge: the local player still has to choose their move.
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Choose your move — aim!"
    );
  });

  it("renders an eliminated pawn as out (server-reported)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p1: { eliminated: true } });
    const rail = screen.getByTestId("rail-p1");
    expect(rail.textContent).toContain("Out");
    expect(rail).toHaveClass("opacity-45");
  });

  it("a new authoritative snapshot replaces the picture; without one, nothing changes", async () => {
    const { client, sockets } = await renderGame();
    await feed(sockets, {});
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Choose your move — aim!"
    );

    // No new server push → the store's snapshot is untouched (no local
    // simulation advances anything, not even after real time passes).
    const before = client.getState().snapshot;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(client.getState().snapshot).toBe(before);

    // A new snapshot replaces it wholesale (confirmation reflected).
    await feed(sockets, {}, { p0: { confirmed: true } });
    expect(client.getState().snapshot).not.toBe(before);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Ready — waiting for other players"
    );
  });
});

// ── turn ownership ───────────────────────────────────────────────────────

describe("multiplayer game: round ownership", () => {
  it("enables controls during the aiming round while unconfirmed", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});
    expect(screen.getByTestId("launch")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Power 4" })).toBeEnabled();
  });

  it("disables controls once the local player has locked in (confirmed)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { confirmed: true } });
    expect(screen.getByTestId("launch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Power 4" })).toBeDisabled();
    expect(screen.getByTestId("launch")).toHaveTextContent("Waiting…");
    pointerAim();
    expect(sentCommands(sockets)).toHaveLength(0);
  });

  it("keeps controls enabled while OTHER players are still deciding (simultaneous rounds)", async () => {
    const { sockets } = await renderGame();
    // p1 has locked in; the local player (p0) may still choose freely.
    await feed(sockets, {}, { p1: { confirmed: true } });
    expect(screen.getByTestId("launch")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Power 4" })).toBeEnabled();
  });

  it("disables controls while the round is resolving", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "moving" });
    expect(screen.getByTestId("launch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Power 4" })).toBeDisabled();
    pointerAim();
    expect(sentCommands(sockets)).toHaveLength(0);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Round resolving…"
    );
  });

  it("disables controls when finished", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: "p0" });
    expect(screen.queryByTestId("launch")).toBeNull(); // bar hidden entirely
    expect(screen.queryByTestId("power-readout")).toBeNull();
  });

  it("disables controls for an eliminated local pawn (guard)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { eliminated: true } });
    expect(screen.getByTestId("launch")).toBeDisabled();
    pointerAim();
    expect(sentCommands(sockets)).toHaveLength(0);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "You're out — watching"
    );
  });

  it("canLocalPlayerAct follows only server snapshot facts", () => {
    const base = JSON.parse(wire.snapshot()).state as GameStateSnapshot;
    expect(canLocalPlayerAct(base)).toBe(true); // aiming + alive + unconfirmed
    expect(canLocalPlayerAct(null)).toBe(false);
    expect(canLocalPlayerAct({ ...base, phase: "moving" })).toBe(false);
    expect(canLocalPlayerAct({ ...base, localPawnId: null })).toBe(false);
    expect(
      canLocalPlayerAct({
        ...base,
        pawns: base.pawns.map((p) =>
          p.id === "p0" ? { ...p, eliminated: true } : p
        ),
      })
    ).toBe(false);
    // A confirmed player may not change their locked-in choice…
    expect(
      canLocalPlayerAct({
        ...base,
        pawns: base.pawns.map((p) =>
          p.id === "p0" ? { ...p, confirmed: true } : p
        ),
      })
    ).toBe(false);
    // …while OTHER players' confirmations never gate the local input.
    expect(
      canLocalPlayerAct({
        ...base,
        pawns: base.pawns.map((p) =>
          p.id === "p1" ? { ...p, confirmed: true } : p
        ),
      })
    ).toBe(true);
  });
});

// ── commands ─────────────────────────────────────────────────────────────

describe("multiplayer game: commands", () => {
  it("aim: pointer input sends the protocol aim command (input math only)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});

    pointerAim();
    const commands = sentCommands(sockets);
    expect(commands).toHaveLength(1);
    // jsdom canvas is unmeasured → the input calc falls back to the world
    // center; the envelope and the intent fields are what the wire carries.
    expect(commands[0]).toEqual({ type: "aim", x: 450, y: 350 });
  });

  it("power: sends setPower and shows the pending value until the snapshot replaces it", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { power: 3 });

    fireEvent.click(screen.getByRole("button", { name: "Power 5" }));
    expect(sentCommands(sockets)).toEqual([{ type: "setPower", power: 5 }]);
    // Local pending value for responsiveness (authoritative was 3)…
    expect(screen.getByTestId("power-readout")).toHaveTextContent("5");
    // …and the next server snapshot replaces it authoritatively.
    await feed(sockets, { power: 4 });
    expect(screen.getByTestId("power-readout")).toHaveTextContent("4");
  });

  it("launch: sends confirmLaunch", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});

    fireEvent.click(screen.getByTestId("launch"));
    expect(sentCommands(sockets)).toEqual([{ type: "confirmLaunch" }]);
  });

  it("sends nothing while disconnected", async () => {
    const { client, sockets } = await renderGame();
    await feed(sockets, {});

    await act(async () => {
      sockets[0].close(); // the connection drops
    });
    expect(client.getState().status).toBe("disconnected");

    pointerAim();
    fireEvent.click(screen.getByTestId("launch"));
    fireEvent.click(screen.getByRole("button", { name: "Power 4" }));
    expect(sentCommands(sockets)).toHaveLength(0);
  });

  it("server command rejections are displayed as normal errors", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});

    await act(async () => {
      sockets[0].serverMessage(
        JSON.stringify({
          protocolVersion: 1,
          type: "error",
          code: "wrong-player",
          message: "the player is eliminated",
        })
      );
    });

    const banner = screen.getByTestId("error-banner");
    expect(banner).toHaveTextContent("wrong-player");
    // The screen stays functional — the player can dismiss and continue.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.getByTestId("launch")).toBeEnabled();
  });
});

// ── match completion ─────────────────────────────────────────────────────

describe("multiplayer game: match completion", () => {
  it("displays the winner from the finished snapshot", async () => {
    const { sockets } = await renderGame();
    await feed(
      sockets,
      { phase: "finished", winnerId: "p0" },
      { p0: { isLocal: true } }
    );
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("Victory!"); // local pawn p0 won
    expect(result).toHaveTextContent("Flawless round.");
    expect(screen.getByTestId("back-to-lobby")).toBeInTheDocument();
  });

  it("displays a loss for the local player when someone else wins", async () => {
    const { sockets } = await renderGame();
    await feed(
      sockets,
      { phase: "finished", winnerId: "p1" },
      { p0: { isLocal: true } }
    );
    expect(screen.getByTestId("match-result")).toHaveTextContent(
      "Player 2 wins the match."
    );
  });

  it("handles match_finished and displays a null winner as no-survivor", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: null });
    await act(async () => {
      sockets[0].serverMessage(wire.matchFinished(null));
    });
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("No Survivor!");
    expect(result).toHaveTextContent("Every pawn left the arena");
  });

  it("Back to lobby leaves the room (leave_room on the wire)", async () => {
    const { client, sockets } = await renderGame();
    await feed(
      sockets,
      { phase: "finished", winnerId: "p0" },
      { p0: { isLocal: true } }
    );

    fireEvent.click(screen.getByTestId("back-to-lobby"));
    const last = JSON.parse(
      sockets[0].sent[sockets[0].sent.length - 1]
    ) as Record<string, unknown>;
    expect(last).toEqual({ protocolVersion: 1, type: "leave_room" });
    expect(client.getState().status).toBe("connected"); // still connected
  });
});

// ── disconnect during the match ──────────────────────────────────────────

describe("multiplayer game: disconnect during the match", () => {
  it("keeps the last snapshot visible, refuses input, offers reconnect", async () => {
    const { client, sockets } = await renderGame();
    await feed(sockets, {});

    await act(async () => {
      sockets[0].close(); // unexpected drop
    });

    // The last authoritative picture stays on screen…
    expect(screen.getByTestId("rail-p0")).toBeInTheDocument();
    expect(screen.getByTestId("rail-p1")).toBeInTheDocument();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Choose your move — aim!"
    );
    // …input is refused…
    pointerAim();
    fireEvent.click(screen.getByTestId("launch"));
    expect(sentCommands(sockets)).toHaveLength(0);
    // …the connection banner tells the truth and offers a way back…
    const banner = screen.getByTestId("connection-banner");
    expect(banner).toHaveTextContent("Disconnected from the match");
    expect(
      screen.getByRole("button", { name: "Reconnect" })
    ).toBeInTheDocument();
    // …and nothing simulated locally in the meantime.
    expect(client.getState().snapshot).toBeNull(); // store cleared honestly
  });
});

// ── lobby routing into the game screen ───────────────────────────────────

describe("lobby → game screen transition", () => {
  it("the server's playing state hands the screen to the multiplayer game", async () => {
    const { client, sockets } = createScriptedClient();
    renderLobby(client);
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
      sockets[0].serverMessage(wire.welcome("p0", "r1"));
    });
    expect(screen.queryByRole("button", { name: "Create Room" })).toBeNull();

    await act(async () => {
      sockets[0].serverMessage(wire.roomState("playing", [
        { playerId: "p0", connected: true },
      ]));
    });
    expect(await screen.findByText("Multiplayer match")).toBeInTheDocument();
    expect(screen.queryByTestId("room-panel")).toBeNull();

    // Snapshot arrives → the game renders it.
    await feed(sockets, {});
    expect(screen.getByTestId("arena-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Choose your move — aim!"
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Round decision countdown — presentation of the server-stamped deadline.
// The screen may SHOW the remaining decision time; it must never DO
// anything about it.
// ────────────────────────────────────────────────────────────────────────

describe("multiplayer game: round decision countdown", () => {
  it("shows the countdown only while the authoritative snapshot says aiming", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { roundDeadline: Date.now() + 10_000 });
    expect(screen.getByTestId("round-countdown")).toHaveTextContent("Decision time");
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("10");

    // The server resolves (early or by deadline) → the authoritative
    // moving snapshot removes the countdown at once.
    await feed(sockets, { phase: "moving", roundDeadline: null });
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Round resolving…");

    // Finished → still gone.
    await feed(sockets, { phase: "finished", roundDeadline: null, winnerId: "p1" });
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();

    // A fresh aiming round with a fresh deadline → back, from the NEW value.
    await feed(sockets, { roundDeadline: Date.now() + 9_800 });
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("10");
  });

  it("renders no countdown without server deadline metadata (older servers)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}); // the default scripted snapshot has no deadline
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");
  });

  it("the countdown reaching zero sends NOTHING and resolves NOTHING — only the server moves the round on", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { roundDeadline: Date.now() + 250 });
    // A short deadline: already "1" (or "0" on a very slow render — the
    // display clamps; either way it is about to run out).
    expect(screen.getByTestId("round-countdown-seconds").textContent).toMatch(/^[01]$/);

    // The local clock passes the deadline and the display clamps at 0…
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("0");

    // …and NOTHING happened: no command left the client (there is no
    // timeout command and no client authority over the round), and the
    // screen still shows the last authoritative aiming state.
    expect(sentCommands(sockets)).toEqual([]);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("0");

    // Only the SERVER's snapshot ends the round.
    await feed(sockets, { phase: "moving", roundDeadline: null });
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Round resolving…");
  });

  it("a new snapshot's deadline replaces the display (next round or reconnect)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { roundDeadline: Date.now() + 2_000 });
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("2");
    // A later authoritative snapshot (fresh round / recovered seat) wins —
    // there is no locally stored deadline to restore.
    await feed(sockets, { roundDeadline: Date.now() + 10_000 });
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("10");
  });
});
