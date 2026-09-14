// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CONFIG, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import { focusableWithin } from "../components/game/focusTrap";
import {
  allSent,
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * STAYING IN THE ROOM AFTER A MATCH (Task 25) — through the real stack:
 * real game server + transport + network client + Lobby/MultiplayerGame.
 *
 * The bug this pins the fix for was purely client-side: the room always
 * survived a finished match server-side, but the overlay's only action
 * was "Back to lobby", which called leaveRoom() and dropped the player
 * on the home screen. Two players who had just played each other had no
 * way to play again without re-creating and re-sharing a room.
 *
 * What these tests pin:
 *   - "Play again" keeps the seat and the room (no leave_room frame) and
 *     hands the SAME pre-match lobby back, room code and roster intact;
 *   - a second match starts from there through the existing Start Match;
 *   - "Leave room" is still a real, separate exit that releases the seat;
 *   - Task 11/16 focus, trap and announcement behaviour survives the
 *     overlay gaining a second button — including Escape, which now maps
 *     to the non-destructive action.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const MAX = CONFIG.match.maxPlayers;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return predicate();
}

/** Two seated players in one private room, rendered as the host. */
async function seatTwoPlayers() {
  const harness = createServerHarness();
  const host = harness.addPlayer();
  const guest = harness.addPlayer();

  renderLobby(host.client);
  await connectPlayer(host);
  fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
  const roomId = host.client.getState().roomId as string;
  // The player-facing code, read from the UI (the client state has no
  // roomCode field — the room panel renders what the server reported).
  const roomCode = (await screen.findByTestId("room-code")).textContent ?? "";
  expect(roomCode).not.toBe("");

  await connectPlayer(guest);
  await playerAct(() => guest.client.joinRoom(roomId));
  expect(host.client.getState().roster).toHaveLength(2);

  return { harness, host, guest, roomId, roomCode };
}

/**
 * Play the running match to its end: the guest knocks itself out, the
 * host stays silent, and the SERVER's deadline resolves the round. The
 * host (p0) wins. Nothing about match-end determination is touched —
 * this is the real engine deciding.
 */
async function playToFinish(
  harness: Awaited<ReturnType<typeof seatTwoPlayers>>["harness"],
  host: Awaited<ReturnType<typeof seatTwoPlayers>>["host"],
  guest: Awaited<ReturnType<typeof seatTwoPlayers>>["guest"],
  roomId: string
) {
  expect(
    await waitFor(() => host.client.getState().snapshot !== null, 5000)
  ).toBe(true);
  const snap = host.client.getState().snapshot as GameStateSnapshot;
  const me = snap.pawns.find((p) => p.id === "p1")!;
  const dx = me.position.x - CX || 1;
  const dy = me.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;

  await playerAct(() => {
    guest.client.submitCommand({
      type: "aim",
      x: CX + (dx / len) * 400,
      y: CY + (dy / len) * 400,
    });
  });
  await playerAct(() =>
    guest.client.submitCommand({ type: "setPower", power: 5 })
  );
  await playerAct(() =>
    guest.client.submitCommand({ type: "confirmLaunch" })
  );
  await playerAct(() => harness.gameServer.resolveRound(roomId));

  expect(
    await waitFor(() => host.client.getState().winnerId === "p0", 10000)
  ).toBe(true);
}

// ────────────────────────────────────────────────────────────────────────
// Play again: stay in the room
// ────────────────────────────────────────────────────────────────────────

describe("Play again keeps the players in their room", () => {
  it("returns to the SAME room's pre-match lobby without leaving", async () => {
    const { harness, host, guest, roomId, roomCode } = await seatTwoPlayers();
    fireEvent.click(screen.getByTestId("start-match"));
    expect(
      await screen.findByTestId("arena-canvas", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    await playToFinish(harness, host, guest, roomId);

    // The result overlay offers BOTH actions.
    await screen.findByTestId("match-result", {}, { timeout: 5000 });
    const playAgain = screen.getByTestId("play-again");
    expect(playAgain).toBeEnabled();
    expect(screen.getByTestId("back-to-lobby")).toBeEnabled();

    fireEvent.click(playAgain);

    // Back in the pre-match lobby — the SAME room, not the home screen.
    expect(
      await screen.findByTestId("start-match", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("match-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("arena-canvas")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create Room" })
    ).not.toBeInTheDocument();

    // Same room id, same code, both players still seated.
    expect(host.client.getState().roomId).toBe(roomId);
    expect(screen.getByTestId("room-code")).toHaveTextContent(roomCode);
    expect(host.client.getState().roomState).toBe("waiting");
    expect(host.client.getState().roster).toHaveLength(2);
    expect(guest.client.getState().roomId).toBe(roomId);
    expect(guest.client.getState().roomState).toBe("waiting");

    // Crucially: the seat was never given up.
    const frames = allSent(host.pairs[0]!);
    expect(frames.filter((f) => f.type === "leave_room")).toHaveLength(0);
    expect(frames.filter((f) => f.type === "return_to_lobby")).toHaveLength(1);
    expect(host.client.getState().lastError).toBeNull();
    expect(guest.client.getState().lastError).toBeNull();
  }, 40000);

  it("starts a SECOND match from that lobby with the existing Start Match", async () => {
    const { harness, host, guest, roomId } = await seatTwoPlayers();
    fireEvent.click(screen.getByTestId("start-match"));
    await screen.findByTestId("arena-canvas", {}, { timeout: 5000 });
    await playToFinish(harness, host, guest, roomId);

    await screen.findByTestId("match-result", {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId("play-again"));
    const startAgain = await screen.findByTestId(
      "start-match",
      {},
      { timeout: 5000 }
    );

    // The very same button that started the first match starts the next.
    fireEvent.click(startAgain);
    expect(
      await screen.findByTestId("arena-canvas", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(
      await waitFor(
        () => host.client.getState().roomState === "playing",
        5000
      )
    ).toBe(true);

    // A genuinely fresh match: nobody eliminated, no winner, no overlay.
    expect(
      await waitFor(() => {
        const s = host.client.getState().snapshot as GameStateSnapshot | null;
        return s !== null && s.phase !== "finished" && !s.pawns.some((p) => p.eliminated);
      }, 5000)
    ).toBe(true);
    expect(host.client.getState().winnerId).toBeNull();
    expect(screen.queryByTestId("match-result")).not.toBeInTheDocument();

    // Two start_match frames, one per match — one mechanism, used twice.
    expect(
      allSent(host.pairs[0]!).filter((f) => f.type === "start_match")
    ).toHaveLength(2);
  }, 40000);

  it("brings EVERY player back to the lobby, whoever pressed it", async () => {
    // The room state is server-authoritative, so one player choosing to
    // stay returns the whole room to waiting — nobody is left staring at
    // a result screen for a match that is over.
    const { harness, host, guest, roomId } = await seatTwoPlayers();
    fireEvent.click(screen.getByTestId("start-match"));
    await screen.findByTestId("arena-canvas", {}, { timeout: 5000 });
    await playToFinish(harness, host, guest, roomId);

    // The GUEST (not the host) asks to go back.
    await playerAct(() => guest.client.returnToLobby());

    expect(
      await screen.findByTestId("start-match", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(host.client.getState().roomState).toBe("waiting");
    expect(guest.client.getState().roomState).toBe("waiting");
    expect(host.client.getState().roomId).toBe(roomId);
  }, 40000);
});

// ────────────────────────────────────────────────────────────────────────
// Leave: the separate, explicit exit
// ────────────────────────────────────────────────────────────────────────

describe("Leave room is still a real, separate exit", () => {
  it("releases the seat and returns to the home screen", async () => {
    const { harness, host, guest, roomId } = await seatTwoPlayers();
    fireEvent.click(screen.getByTestId("start-match"));
    await screen.findByTestId("arena-canvas", {}, { timeout: 5000 });
    await playToFinish(harness, host, guest, roomId);
    await screen.findByTestId("match-result", {}, { timeout: 5000 });

    fireEvent.click(screen.getByTestId("back-to-lobby"));

    // Home screen — a real exit, not the room's lobby.
    expect(
      await screen.findByRole("button", { name: "Create Room" }, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("start-match")).not.toBeInTheDocument();
    expect(screen.queryByTestId("match-result")).not.toBeInTheDocument();

    const frames = allSent(host.pairs[0]!);
    expect(frames.filter((f) => f.type === "leave_room")).toHaveLength(1);

    // The server released the seat. The room is still "finished" here,
    // so Task 18's frozen roster keeps the seat LISTED as disconnected
    // rather than deleting it — the release shows as connected:false,
    // and the room itself lives on for the guest.
    expect(
      await waitFor(() => {
        const seats = harness.gameServer.getRoom(roomId)?.seats ?? [];
        return seats.some((s) => s.playerId === "p0" && !s.connected);
      }, 5000)
    ).toBe(true);
    expect(harness.gameServer.getRoom(roomId)).not.toBeNull();
    expect(guest.client.getState().roomId).toBe(roomId);

    // And once the room reopens, the freed seat is genuinely gone.
    await playerAct(() => guest.client.returnToLobby());
    expect(
      await waitFor(
        () => (harness.gameServer.getRoom(roomId)?.seats.length ?? 0) === 1,
        5000
      )
    ).toBe(true);
  }, 40000);

  it("destroys the room once the last player leaves after a match", async () => {
    const { harness, host, guest, roomId } = await seatTwoPlayers();
    fireEvent.click(screen.getByTestId("start-match"));
    await screen.findByTestId("arena-canvas", {}, { timeout: 5000 });
    await playToFinish(harness, host, guest, roomId);
    await screen.findByTestId("match-result", {}, { timeout: 5000 });

    fireEvent.click(screen.getByTestId("back-to-lobby"));
    await playerAct(() => guest.client.leaveRoom());

    expect(
      await waitFor(() => harness.gameServer.getRoom(roomId) === null, 5000)
    ).toBe(true);
    expect(harness.gameServer.roomCount()).toBe(0);
  }, 40000);
});

// ────────────────────────────────────────────────────────────────────────
// Task 11 / 16 accessibility, with the second button present
// ────────────────────────────────────────────────────────────────────────

describe("the result overlay stays accessible with two actions", () => {
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
  const sixPawns = (winnerSlot: number) =>
    Array.from({ length: MAX }, (_, i) =>
      pawn(i, { eliminated: i !== winnerSlot })
    );

  /** Render the overlay with both actions, announcement flushed. */
  async function renderBoth(
    overrides: {
      onLeave?: () => void;
      onPlayAgain?: () => void;
      getRestoreFocusFallback?: () => HTMLElement | null;
    } = {}
  ) {
    const view = render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={overrides.onLeave ?? (() => {})}
        onPlayAgain={overrides.onPlayAgain ?? (() => {})}
        getRestoreFocusFallback={overrides.getRestoreFocusFallback}
      />
    );
    // The live region publishes one commit after mount.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    return view;
  }

  const dialog = () => screen.getByTestId("match-result");

  it("announces the result exactly once, unchanged by the new button", async () => {
    await renderBoth();
    const region = screen.getByTestId("match-result-announcement");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveTextContent(
      "Match over. You were knocked out. Player 6 wins the match."
    );
    // The action labels are presentation, never part of the sentence.
    expect(region.textContent).not.toContain("Play again");
    expect(region.textContent).not.toContain("Leave room");
  });

  it("still focuses the dialog itself, so the result is read first", async () => {
    await renderBoth();
    expect(dialog()).toHaveFocus();
  });

  it("puts Play again first in the tab order and traps Tab across both", async () => {
    // NOTE: jsdom performs no native sequential focus movement, so the
    // trap is observable exactly where it intervenes — at the dialog
    // boundaries. Interior Tab steps are the browser's job and cannot be
    // simulated here; what is pinned is the ORDER and the WRAPPING.
    await renderBoth();
    const playAgain = screen.getByTestId("play-again");
    const leave = screen.getByTestId("back-to-lobby");

    // Both actions are tabbable, and staying comes first.
    expect(focusableWithin(dialog())).toEqual([playAgain, leave]);

    // First Tab from the container enters on the primary action.
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(playAgain).toHaveFocus();

    // Tab off the LAST action wraps back to the first, never out.
    leave.focus();
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(playAgain).toHaveFocus();

    // Shift+Tab off the FIRST wraps to the last, never out.
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(leave).toHaveFocus();

    // Shift+Tab from the container also stays inside.
    dialog().focus();
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(leave).toHaveFocus();
  });

  it("routes Escape to the non-destructive action (Play again)", async () => {
    // Escape is a reflex key: it must not be the one that throws away a
    // seat and a room code.
    const onLeave = vi.fn();
    const onPlayAgain = vi.fn();
    await renderBoth({ onLeave, onPlayAgain });

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("keeps both buttons operable while focus is trapped", async () => {
    const onLeave = vi.fn();
    const onPlayAgain = vi.fn();
    await renderBoth({ onLeave, onPlayAgain });

    fireEvent.click(screen.getByTestId("play-again"));
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("back-to-lobby"));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
  });

  it("restores focus when the overlay closes on Play again", async () => {
    const previous = document.createElement("button");
    document.body.appendChild(previous);
    previous.focus();

    const { unmount } = await renderBoth();
    fireEvent.click(screen.getByTestId("play-again"));
    unmount(); // the parent unmounts it, exactly as the leave path does

    expect(previous).toHaveFocus();
    previous.remove();
  });

  it("falls back to a single leave action when there is no room to stay in", async () => {
    // Without onPlayAgain the overlay is exactly its pre-Task-25 self —
    // no dead affordance, and Escape still means leave.
    const onLeave = vi.fn();
    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={onLeave}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });

    expect(screen.queryByTestId("play-again")).not.toBeInTheDocument();
    expect(screen.getByTestId("back-to-lobby")).toHaveTextContent(
      "Back to lobby"
    );
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
