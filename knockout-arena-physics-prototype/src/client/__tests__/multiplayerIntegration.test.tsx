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

/**
 * Strip the per-viewer projection so two clients' snapshots compare equal.
 * (Simultaneous rounds: power/aimDirection/isAiming describe the VIEWER'S
 * OWN pawn, so they differ per client by design. roundDeadline is
 * server timing metadata — identical per broadcast, but two clients can
 * momentarily hold snapshots from different broadcasts, so it is neutralized
 * rather than compared.)
 */
function asAuthoritative(snapshot: GameStateSnapshot) {
  return {
    ...snapshot,
    localPawnId: null,
    power: 0,
    aimDirection: null,
    isAiming: false,
    roundDeadline: null,
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

    // ── the SHARED aiming round: both players may choose at the same time ──
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");
    expect(screen.getByTestId("launch")).toBeEnabled();

    const initialSnap = host.client.getState().snapshot as GameStateSnapshot;
    expect(initialSnap.pawns).toHaveLength(2);
    const initialPositions = initialSnap.pawns.map((p) => ({ ...p.position }));
    // The server-stamped decision deadline arrives with the snapshot: the
    // countdown starts at the full 10-second window (default config).
    expect(typeof initialSnap.roundDeadline).toBe("number");
    expect(screen.getByTestId("round-countdown")).toHaveTextContent("Decision time");
    expect(screen.getByTestId("round-countdown-seconds")).toHaveTextContent("10");

    // ── [20] the HOST chooses first (aim: pointer input → intent → server) ──
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
    expect(aimingSnap.localPawnId).toBe("p0"); // the host's own view
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

    // ── the host LOCKS IN: confirmLaunch does NOT start any movement ──
    fireEvent.click(screen.getByTestId("launch"));
    expect(
      await waitFor(
        () =>
          ((host.client.getState().snapshot as GameStateSnapshot).pawns[0]
            .confirmed === true),
        5000
      )
    ).toBe(true);
    expect((host.client.getState().snapshot as GameStateSnapshot).phase).toBe("aiming"); // still the SAME round
    expect(screen.getByTestId("launch")).toBeDisabled(); // the choice is locked
    expect(screen.getByTestId("launch")).toHaveTextContent("Waiting…");
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Ready — waiting for other players"
    );
    // Nobody moved yet: the host's confirm alone moves nothing.
    const confirmedSnap = host.client.getState().snapshot as GameStateSnapshot;
    expect(confirmedSnap.pawns[0].position).toEqual(initialPositions[0]);
    expect(confirmedSnap.pawns[1].position).toEqual(initialPositions[1]);

    // ── [20] the GUEST chooses independently (headless "browser B") ──
    const guestSnap = guest.client.getState().snapshot as GameStateSnapshot;
    expect(guestSnap.localPawnId).toBe("p1"); // server's projection for B
    await playerAct(() => guest.client.submitCommand({ type: "aim", x: CX, y: CY }));
    await playerAct(() => guest.client.submitCommand({ type: "setPower", power: 2 }));
    await playerAct(() => guest.client.submitCommand({ type: "confirmLaunch" }));

    // The guest's confirmation completes the set → the round resolves with
    // BOTH movements starting together — and the countdown disappears the
    // moment the authoritative moving snapshot arrives.
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).phase === "moving",
        5000
      )
    ).toBe(true);
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("launch")).toBeDisabled(); // not our call anymore

    // Both clients see the SAME authoritative movement.
    const hostMoving = host.client.getState().snapshot as GameStateSnapshot;
    const guestMoving = guest.client.getState().snapshot as GameStateSnapshot;
    expect(asAuthoritative(guestMoving)).toEqual(asAuthoritative(hostMoving));

    // ── the round settles into a fresh aiming round (no turn queue) ──
    expect(
      await waitFor(() => {
        const snap = host.client.getState().snapshot as GameStateSnapshot;
        return snap.phase === "aiming";
      }, 8000)
    ).toBe(true);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");
    expect(screen.getByTestId("launch")).toBeEnabled(); // fresh round, fresh choice

    const settledSnap = host.client.getState().snapshot as GameStateSnapshot;
    // BOTH players' pawns moved during that ONE round — the host's confirm
    // moved nothing by itself, and the guest never needed a "turn" of its
    // own: two independent choices, one shared resolution.
    const settledP0 = settledSnap.pawns.find((p) => p.id === "p0")!;
    const settledP1 = settledSnap.pawns.find((p) => p.id === "p1")!;
    expect(settledP0.position).not.toEqual(initialPositions[0]);
    expect(settledP1.position).not.toEqual(initialPositions[1]);
    expect(settledSnap.pawns.every((p) => !p.confirmed)).toBe(true);

    // ── round 2: the guest knocks itself out; the deadline resolves ──
    const me = settledP1;
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
    // The host stays silent this round — the server's decision deadline
    // (the privileged resolveRound path, never the player wire) resolves it.
    expect(
      await waitFor(
        () =>
          ((guest.client.getState().snapshot as GameStateSnapshot).pawns[1]
            .confirmed === true),
        5000
      )
    ).toBe(true);
    await playerAct(() => harness.gameServer.resolveRound(roomId));

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

  it("the server's round decision deadline resolves a round not everyone confirms in", async () => {
    // A short deadline (1200 ms): the host confirms through the real UI,
    // the guest never chooses — no client ever sends or receives a
    // "timeout" message (the wire has none). The SERVER resolves the
    // round at its own deadline, and both clients simply observe the
    // resulting state transitions.
    const harness = createServerHarness({ roundDecisionTimeoutMs: 1200 });
    const host = harness.addPlayer();
    const guest = harness.addPlayer();

    renderLobby(host.client);
    await connectPlayer(host);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = host.client.getState().roomId as string;

    await connectPlayer(guest);
    await playerAct(() => guest.client.joinRoom(roomId));
    // While still in the waiting room there is no decision countdown at all.
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("start-match"));

    expect(await screen.findByText("Multiplayer match", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByTestId("arena-canvas", {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => host.client.getState().snapshot !== null, 5000);

    const initialSnap = host.client.getState().snapshot as GameStateSnapshot;
    const spawn = initialSnap.pawns.map((p) => ({ ...p.position }));
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");
    // The short (1200 ms) server deadline is visible as a running countdown.
    expect(typeof initialSnap.roundDeadline).toBe("number");
    expect(screen.getByTestId("round-countdown-seconds").textContent).toMatch(/^[0-9]+$/);

    // The host aims and locks in — the only choice anyone makes.
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
    fireEvent.click(screen.getByRole("button", { name: "Power 2" }));
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).power === 2,
        5000
      )
    ).toBe(true);
    fireEvent.click(screen.getByTestId("launch"));
    expect(
      await waitFor(
        () =>
          (host.client.getState().snapshot as GameStateSnapshot).pawns[0].confirmed === true,
        5000
      )
    ).toBe(true);
    // Locked in, but nothing moves yet — the round waits for the deadline.
    expect((host.client.getState().snapshot as GameStateSnapshot).phase).toBe("aiming");
    expect(screen.getByTestId("launch")).toBeDisabled();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Ready — waiting for other players"
    );

    // The deadline fires on the server: the host's confirmed move executes
    // and the silent guest's pawn stays frozen. The countdown vanished with
    // the authoritative moving snapshot (it never resolved anything itself).
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).phase === "moving",
        5000
      )
    ).toBe(true);
    expect(screen.queryByTestId("round-countdown")).not.toBeInTheDocument();
    expect(
      await waitFor(
        () => (guest.client.getState().snapshot as GameStateSnapshot).phase === "moving",
        5000
      )
    ).toBe(true);

    // The round settles into a fresh aiming round for both clients…
    expect(
      await waitFor(() => {
        const snap = host.client.getState().snapshot as GameStateSnapshot;
        return snap.phase === "aiming";
      }, 8000)
    ).toBe(true);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");
    expect(screen.getByTestId("launch")).toBeEnabled(); // a fresh choice
    // …and the fresh round's countdown restarted from the NEW deadline.
    expect(screen.getByTestId("round-countdown-seconds").textContent).toMatch(/^[0-9]+$/);

    // …and the timeout moved exactly the one confirmed pawn.
    const settled = host.client.getState().snapshot as GameStateSnapshot;
    const p0 = settled.pawns.find((p) => p.id === "p0")!;
    const p1 = settled.pawns.find((p) => p.id === "p1")!;
    expect(Math.hypot(p0.position.x - spawn[0].x, p0.position.y - spawn[0].y)).toBeGreaterThan(1);
    expect(p1.position).toEqual(spawn[1]);
    expect(settled.pawns.every((p) => !p.eliminated)).toBe(true); // not an elimination
    expect(settled.pawns.every((p) => !p.confirmed)).toBe(true); // fresh round

    // Both clients hold the SAME authoritative state.
    const guestSettled = guest.client.getState().snapshot as GameStateSnapshot;
    expect(asAuthoritative(guestSettled)).toEqual(asAuthoritative(settled));

    // No protocol additions were involved: no errors, still connected.
    expect(host.client.getState().lastError).toBeNull();
    expect(guest.client.getState().lastError).toBeNull();
  }, 25000);
});
