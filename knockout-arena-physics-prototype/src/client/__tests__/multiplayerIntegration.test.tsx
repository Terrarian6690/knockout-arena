// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import {
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * THE full multiplayer loop, with nothing faked:
 *
 *   real createGameServer + createGameHost + engine + transport core
 *   → in-memory socket pair (the only test stand-in — the "network")
 *   → the REAL browser network client
 *   → the REAL Lobby/MultiplayerGame React UI
 *
 * Two clients play one authoritative match: commands travel the wire, the
 * SERVER's engine simulates, and both clients render the snapshots it
 * broadcasts. This is the automated version of the manual smoke test.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

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

/** Strip the per-viewer projection so two clients' snapshots compare equal. */
function asAuthoritative(snapshot: GameStateSnapshot) {
  return {
    ...snapshot,
    localPawnId: null,
    pawns: snapshot.pawns.map((pawn) => ({ ...pawn, isLocal: false })),
  };
}

describe("two clients play one authoritative match (full stack)", () => {
  it("aim/power/launch flow through the real server to both clients", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();

    // ── the lobby flow: create, join, start (all through the real UI) ──
    renderLobby(host.client);
    await connectPlayer(host);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = host.client.getState().roomId as string;

    await connectPlayer(guest);
    await playerAct(() => guest.client.joinRoom(roomId));
    expect(host.client.getState().roster).toHaveLength(2);

    fireEvent.click(screen.getByTestId("start-match"));

    // The game screen takes over; the first authoritative snapshot arrives.
    expect(await screen.findByText("Multiplayer match", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByTestId("arena-canvas", {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => host.client.getState().snapshot !== null, 5000);

    // p0 (the host) acts first — the server said so, the UI follows.
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Your turn — aim!");
    expect(screen.getByTestId("launch")).toBeEnabled();

    const initialSnap = host.client.getState().snapshot as GameStateSnapshot;
    expect(initialSnap.pawns).toHaveLength(2);
    const initialPositions = initialSnap.pawns.map((p) => ({ ...p.position }));

    // ── aim: pointer input → intent → server engine → new snapshot ──
    fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
      clientX: 120,
      clientY: 80,
    });
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).isAiming === true,
        5000
      )
    ).toBe(true);
    const aimingSnap = host.client.getState().snapshot as GameStateSnapshot;
    expect(aimingSnap.activePawnId).toBe("p0");
    expect(aimingSnap.aimDirection).not.toBeNull();

    // ── power: the authoritative value comes back from the server ──
    fireEvent.click(screen.getByRole("button", { name: "Power 2" }));
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).power === 2,
        5000
      )
    ).toBe(true);

    // ── between server pushes, NOTHING changes locally (no client physics) ──
    const idleSnap = host.client.getState().snapshot;
    expect(
      await waitFor(() => host.client.getState().snapshot !== idleSnap, 350)
    ).toBe(false); // no push while idle → no rerender data → no simulation

    // ── launch: confirmLaunch → the server simulates the movement ──
    fireEvent.click(screen.getByTestId("launch"));
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).phase === "moving",
        5000
      )
    ).toBe(true);
    expect(screen.getByTestId("launch")).toBeDisabled(); // not our call anymore

    // Both clients see the SAME authoritative movement.
    const hostMoving = host.client.getState().snapshot as GameStateSnapshot;
    const guestMoving = guest.client.getState().snapshot as GameStateSnapshot;
    expect(asAuthoritative(guestMoving)).toEqual(asAuthoritative(hostMoving));

    // ── the turn passes to p1 (the guest) once the pawn settles ──
    expect(
      await waitFor(() => {
        const snap = host.client.getState().snapshot as GameStateSnapshot;
        return snap.phase === "aiming" && snap.activePawnId === "p1";
      }, 8000)
    ).toBe(true);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Player 2's turn");
    expect(screen.getByTestId("launch")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Power 4" })
    ).toBeDisabled();

    // Authoritative positions changed (the launch moved p0)…
    const settledSnap = host.client.getState().snapshot as GameStateSnapshot;
    const settledP0 = settledSnap.pawns.find((p) => p.id === "p0")!;
    expect(settledP0.position).not.toEqual(initialPositions[0]);

    // ── the guest plays its own turn (headless "browser B") ──
    const guestSnap = guest.client.getState().snapshot as GameStateSnapshot;
    expect(guestSnap.localPawnId).toBe("p1"); // server's projection for B
    const me = guestSnap.pawns.find((p) => p.id === "p1")!;
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
    await playerAct(() => guest.client.submitCommand({ type: "setPower", power: 5 }));
    await playerAct(() => guest.client.submitCommand({ type: "confirmLaunch" }));

    // The guest knocks itself out → the server finishes the match.
    expect(
      await waitFor(
        () => host.client.getState().winnerId === "p0",
        8000
      )
    ).toBe(true);
    expect(guest.client.getState().winnerId).toBe("p0"); // identical verdict

    // The host's UI shows the elimination and the authoritative result.
    expect(screen.getByTestId("rail-p1").textContent).toContain("Out");
    const result = await screen.findByTestId("match-result", {}, { timeout: 5000 });
    expect(result).toHaveTextContent("Victory!"); // local pawn p0 won

    const hostFinal = host.client.getState().snapshot as GameStateSnapshot;
    const guestFinal = guest.client.getState().snapshot as GameStateSnapshot;
    expect(hostFinal.phase).toBe("finished");
    expect(asAuthoritative(guestFinal)).toEqual(asAuthoritative(hostFinal));

    // Clean flow: no server errors were involved anywhere.
    expect(host.client.getState().lastError).toBeNull();
    expect(guest.client.getState().lastError).toBeNull();
  }, 25000);
});
