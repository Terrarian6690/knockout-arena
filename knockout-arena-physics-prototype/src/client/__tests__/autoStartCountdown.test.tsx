// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoStartCountdown } from "../components/lobby/AutoStartCountdown";
import {
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * THE AUTO-START COUNTDOWN, CLIENT SIDE (Task 28).
 *
 * The rule under test is Section 9's: client timers are PRESENTATION
 * ONLY. The countdown must be derived from the server's absolute
 * `autoStartDeadline` timestamp and must contain no duration logic of
 * its own — it does not know the 2→5min…6→3s table, and it never starts
 * a match. That is exactly how Task 22's round countdown works, and this
 * reuses the pattern.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── the display derives from the deadline, nothing else ──────────────────

describe("the countdown renders a server deadline, not a local duration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  const renderAt = (deadline: number | null) =>
    render(<AutoStartCountdown deadline={deadline} />);

  it("shows the remaining time implied by the timestamp", () => {
    renderAt(Date.now() + 42_000);
    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "42s"
    );
  });

  it("formats minutes as m:ss above a minute", () => {
    // 5 minutes is the two-player value, but the component is only told
    // a timestamp — it never names the table.
    renderAt(Date.now() + 300_000);
    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "5:00"
    );
  });

  it("ticks down as real time passes, without being told a duration", () => {
    renderAt(Date.now() + 10_000);
    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "10s"
    );

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "6s"
    );
  });

  it("follows a NEW deadline immediately when the server re-arms", () => {
    // The whole point of the clamp rule living server-side: when a
    // player joins, the client just receives a nearer timestamp.
    const { rerender } = renderAt(Date.now() + 300_000);
    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "5:00"
    );

    rerender(<AutoStartCountdown deadline={Date.now() + 3_000} />);

    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "3s"
    );
  });

  it("clamps at zero instead of going negative past the deadline", () => {
    // The local clock is not assumed to match the server's: an overdue
    // deadline holds at 0 while the authoritative start arrives.
    renderAt(Date.now() + 1_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByTestId("auto-start-countdown-time")).toHaveTextContent(
      "0s"
    );
  });

  it("renders nothing at all without a deadline", () => {
    renderAt(null);
    expect(screen.queryByTestId("auto-start-countdown")).toBeNull();
  });

  it("degrades quietly if the server sends nonsense", () => {
    // Presentation metadata must never break the lobby.
    render(
      <AutoStartCountdown
        deadline={"soon" as unknown as number}
      />
    );
    expect(screen.queryByTestId("auto-start-countdown")).toBeNull();
  });

  it("announces the remaining time to assistive technology", () => {
    renderAt(Date.now() + 90_000);
    const timer = screen.getByTestId("auto-start-countdown");

    expect(timer).toHaveAttribute("role", "timer");
    expect(timer).toHaveAccessibleName("Match starts automatically in 1 minute 30 seconds");
  });

  it("turns urgent in the last ten seconds", () => {
    renderAt(Date.now() + 30_000);
    expect(screen.getByTestId("auto-start-countdown")).toHaveAttribute(
      "data-urgent",
      "false"
    );

    act(() => {
      vi.advanceTimersByTime(25_000);
    });

    expect(screen.getByTestId("auto-start-countdown")).toHaveAttribute(
      "data-urgent",
      "true"
    );
  });
});

// ── end-to-end against the real server ───────────────────────────────────

describe("the waiting room shows the countdown the server armed", () => {
  it("appears only once a second player makes the room startable", async () => {
    const harness = createServerHarness();
    const one = harness.addPlayer();
    const two = harness.addPlayer();
    await connectPlayer(one);
    await connectPlayer(two);
    renderLobby(one.client);

    await act(async () => {
      one.client.joinPublicRoom();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Alone: the server armed nothing, so nothing is displayed.
    expect(screen.queryByTestId("auto-start-countdown")).toBeNull();

    await act(async () => {
      two.client.joinPublicRoom();
      await new Promise((r) => setTimeout(r, 20));
    });

    const countdown = await screen.findByTestId("auto-start-countdown");
    expect(countdown).toBeInTheDocument();
    // The displayed value came from the server's timestamp: five
    // minutes for two players.
    expect(one.client.getState().autoStartDeadline).not.toBeNull();
    expect(
      screen.getByTestId("auto-start-countdown-time").textContent
    ).toMatch(/^[45]:\d\d$/);
  });

  it("public rooms offer no start button and no host badge", async () => {
    // Task 28: no player has start authority in a public room, so the
    // control and the label that advertised it are both gone.
    const harness = createServerHarness();
    const one = harness.addPlayer();
    const two = harness.addPlayer();
    await connectPlayer(one);
    await connectPlayer(two);
    renderLobby(one.client);

    await act(async () => {
      one.client.joinPublicRoom();
      two.client.joinPublicRoom();
      await new Promise((r) => setTimeout(r, 20));
    });

    await screen.findByTestId("auto-start-countdown");
    expect(screen.queryByTestId("start-match")).toBeNull();
    expect(screen.queryByTestId("host-badge")).toBeNull();
    expect(screen.queryByTestId("waiting-for-host")).toBeNull();
  });

  it("the countdown disappears when the room drops back to one player", async () => {
    const harness = createServerHarness();
    const one = harness.addPlayer();
    const two = harness.addPlayer();
    await connectPlayer(one);
    await connectPlayer(two);
    renderLobby(one.client);

    await act(async () => {
      one.client.joinPublicRoom();
      two.client.joinPublicRoom();
      await new Promise((r) => setTimeout(r, 20));
    });
    await screen.findByTestId("auto-start-countdown");

    await act(async () => {
      two.client.leaveRoom();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.queryByTestId("auto-start-countdown")).toBeNull();
    expect(one.client.getState().autoStartDeadline).toBeNull();
    // …and the "waiting for someone" copy is back.
    expect(screen.getByTestId("waiting-for-players")).toBeInTheDocument();
  });
});

// ── private rooms are visibly unchanged ──────────────────────────────────

describe("private rooms keep the host's start button", () => {
  it("show Start Match and the Host badge, and no countdown", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    await connectPlayer(host);
    renderLobby(host.client);

    await act(async () => {
      host.client.createRoom();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(await screen.findByTestId("start-match")).toBeInTheDocument();
    expect(screen.getByTestId("host-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("auto-start-countdown")).toBeNull();
    expect(host.client.getState().autoStartDeadline).toBeNull();
  });
});
