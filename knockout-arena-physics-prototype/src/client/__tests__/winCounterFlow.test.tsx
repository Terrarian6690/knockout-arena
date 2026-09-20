// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import {
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * THE WIN COUNTER, END TO END — real server, real engine, real UI.
 *
 * The bug this pins: the server credited the win and the wire carried
 * it, but the CLIENT's roster parser dropped the additive `wins` field,
 * so the lobby counter never moved. The full loop must hold: a won
 * match → the winner clicks "Play again" → the returned lobby shows
 * their seat with `wins: 1`.
 */

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

describe("a won match moves the lobby win counter", () => {
  it("winner returns to the lobby and their seat reads wins: 1", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();

    renderLobby(host.client);
    await connectPlayer(host);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = host.client.getState().roomId as string;
    await screen.findByTestId("room-code");

    await connectPlayer(guest);
    await playerAct(() => guest.client.joinRoom(roomId));
    await waitFor(() => host.client.getState().roster.length === 2, 5000);

    // Start the match (the host's Start button) and play it for real:
    // the guest knocks itself out, the server's loop decides, the host
    // (p0) wins.
    await playerAct(() => fireEvent.click(screen.getByTestId("start-match")));
    expect(
      await waitFor(() => host.client.getState().snapshot !== null, 8000)
    ).toBe(true);
    expect(await screen.findByTestId("match-rail")).toBeInTheDocument();

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

    // Server truth: the win is on the winner's seat…
    const room = harness.gameServer.getRoom(roomId)!;
    expect(room.seats.map((s) => s.wins ?? 0)).toEqual([1, 0]);

    // …and after "Play again" the CLIENT's roster carries it too (the
    // parser must keep the additive field) and the seat renders it.
    await playerAct(() => fireEvent.click(screen.getByTestId("play-again")));
    await waitFor(() => screen.queryByTestId("seat-list") !== null, 8000);
    expect(
      host.client.getState().roster.find((s) => s.playerId === "p0")?.wins
    ).toBe(1);
    const winsP0 = within(screen.getByTestId("seat-p0")).getByTestId(
      "wins-p0"
    );
    expect(winsP0).toHaveTextContent("wins: 1");
    // The loser stays at zero.
    expect(
      within(screen.getByTestId("seat-p1")).getByTestId("wins-p1")
    ).toHaveTextContent("wins: 0");
    // …and the winner is the crown wearer at the top of the list.
    expect(within(screen.getByTestId("seat-p0")).getByTestId("crown-p0"));
  }, 30000);
});
