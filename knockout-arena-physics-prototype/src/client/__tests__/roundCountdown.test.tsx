// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoundCountdown } from "../components/game/RoundCountdown";

/**
 * The round decision countdown — the PRESENTATION half of the
 * server-authoritative deadline. Everything here pins one rule: the
 * component renders `max(0, deadline - localNow)` from the snapshot's
 * server-stamped absolute deadline and does absolutely nothing else.
 * It never sends, never resolves, never stores a deadline of its own.
 *
 * Deadlines are crafted relative to Date.now() so every assertion is
 * immediate — no test waits out a real countdown.
 */

// Explicit cleanup: the repo's vitest setup does not enable RTL's global
// auto-cleanup (no globals: true), so each test tears down its renders.
afterEach(cleanup);

const countdown = () => screen.getByTestId("round-countdown");
const seconds = () => screen.getByTestId("round-countdown-seconds");
const absent = () => screen.queryByTestId("round-countdown");

describe("RoundCountdown (presentation of the authoritative deadline)", () => {
  it("renders the label and remaining seconds from the server's absolute deadline", () => {
    render(<RoundCountdown phase="aiming" deadline={Date.now() + 10_000} />);
    expect(countdown()).toHaveTextContent("Decision time");
    expect(seconds()).toHaveTextContent("10"); // a full window starts at 10
  });

  it("renders partial seconds rounded up (6.8 s left → 7)", () => {
    render(<RoundCountdown phase="aiming" deadline={Date.now() + 6_800} />);
    expect(seconds()).toHaveTextContent("7");
  });

  it("ticks down as time passes (a display ticker, nothing more)", async () => {
    render(<RoundCountdown phase="aiming" deadline={Date.now() + 2_900} />);
    // Whatever the (loaded) machine's render delay, the display must move
    // DOWN within a moment — a pure display decrement, nothing else.
    const initial = Number(seconds().textContent);
    expect(initial).toBeLessThanOrEqual(3);
    await waitFor(
      () => expect(Number(seconds().textContent)).toBeLessThan(initial),
      { timeout: 1500 }
    );
  });

  it("clamps at zero — never negative — and holds 0 while awaiting the server", async () => {
    render(<RoundCountdown phase="aiming" deadline={Date.now() - 5_000} />);
    expect(seconds()).toHaveTextContent("0");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(seconds()).toHaveTextContent("0"); // still 0: only the server moves on
  });

  it("marks the last seconds as urgent (and only those)", () => {
    const calm = render(
      <RoundCountdown phase="aiming" deadline={Date.now() + 9_000} />
    );
    expect(countdown()).toHaveAttribute("data-urgent", "false");
    calm.unmount();
    render(<RoundCountdown phase="aiming" deadline={Date.now() + 2_000} />);
    expect(countdown()).toHaveAttribute("data-urgent", "true");
  });

  it("renders NOTHING outside the aiming phase — even with a deadline present", () => {
    const first = render(
      <RoundCountdown phase="aiming" deadline={Date.now() + 10_000} />
    );
    expect(countdown()).toBeInTheDocument(); // control: aiming shows it
    first.unmount();

    const moving = render(
      <RoundCountdown phase="moving" deadline={Date.now() + 5_000} />
    );
    expect(absent()).not.toBeInTheDocument(); // resolution: no countdown
    moving.unmount();

    const finished = render(
      <RoundCountdown phase="finished" deadline={Date.now() + 5_000} />
    );
    expect(absent()).not.toBeInTheDocument(); // finished: no countdown
    finished.unmount();
  });

  it("renders NOTHING without server deadline metadata (older servers, malformed values)", () => {
    const none = render(<RoundCountdown phase="aiming" deadline={null} />);
    expect(absent()).not.toBeInTheDocument();
    none.unmount();

    const missing = render(<RoundCountdown phase="aiming" deadline={undefined} />);
    expect(absent()).not.toBeInTheDocument();
    missing.unmount();

    const garbage = render(
      <RoundCountdown phase="aiming" deadline={"soon" as unknown as number} />
    );
    expect(absent()).not.toBeInTheDocument(); // tolerated, never trusted
    garbage.unmount();
  });

  it("a NEW round's deadline replaces the display — no stale countdown leaks", () => {
    const { rerender } = render(
      <RoundCountdown phase="aiming" deadline={Date.now() + 1_500} />
    );
    expect(seconds()).toHaveTextContent("2");
    // The server resolved and opened a new round with a fresh (later)
    // deadline — the display follows the NEW snapshot value immediately.
    rerender(<RoundCountdown phase="aiming" deadline={Date.now() + 9_600} />);
    expect(seconds()).toHaveTextContent("10");
    // And once that round resolves, the phase gate removes it entirely.
    rerender(<RoundCountdown phase="moving" deadline={null} />);
    expect(absent()).not.toBeInTheDocument();
  });
});
