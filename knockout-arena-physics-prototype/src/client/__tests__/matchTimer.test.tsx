// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, type GamePhase } from "../../game";
import { MatchTimer, formatMatchClock } from "../components/game/MatchTimer";

/**
 * The MATCH TIME LIMIT display — the presentation half of the
 * authoritative 4-minute clock.
 *
 * The rule under test is always the same: this component renders
 * `snapshot.matchDeadline - now` and nothing else. It owns no countdown
 * state, so it cannot disagree with the server, cannot keep running
 * after the match ends, and shows the right value the instant a
 * reconnecting client receives its first snapshot.
 *
 * Timers are faked, so nothing waits in real time.
 */

const DURATION = CONFIG.match.durationMs;
const START = 1_700_000_000_000; // a fixed "now" for every test

const timer = () => screen.getByTestId("match-timer");
const absent = () => screen.queryByTestId("match-timer");
const clock = () => screen.getByTestId("match-timer-clock");

/** Render the timer as if the server said "the match ends in `ms`". */
function renderIn(ms: number, phase: GamePhase = "aiming") {
  return render(<MatchTimer phase={phase} deadline={Date.now() + ms} />);
}

/** Advance both the fake timers and the fake wall clock together. */
function tickClock(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatting", () => {
  it("renders the full four minutes as 4:00", () => {
    expect(formatMatchClock(DURATION / 1000)).toBe("4:00");
  });

  it("zero-pads the seconds", () => {
    expect(formatMatchClock(239)).toBe("3:59");
    expect(formatMatchClock(125)).toBe("2:05");
    expect(formatMatchClock(61)).toBe("1:01");
    expect(formatMatchClock(60)).toBe("1:00");
  });

  it("drops below a minute without a leading minute digit trick", () => {
    expect(formatMatchClock(59)).toBe("0:59");
    expect(formatMatchClock(9)).toBe("0:09");
  });

  it("bottoms out at 0:00 and never shows negative time", () => {
    expect(formatMatchClock(0)).toBe("0:00");
    expect(formatMatchClock(-1)).toBe("0:00");
    expect(formatMatchClock(-90)).toBe("0:00");
  });
});

describe("what the clock shows", () => {
  it("shows 4:00 at the start of a match", () => {
    renderIn(DURATION);
    expect(clock()).toHaveTextContent("4:00");
  });

  it("counts down as real time passes", () => {
    renderIn(DURATION);
    tickClock(1_000);
    expect(clock()).toHaveTextContent("3:59");
    tickClock(59_000);
    expect(clock()).toHaveTextContent("3:00");
    tickClock(120_000);
    expect(clock()).toHaveTextContent("1:00");
  });

  it("crosses the minute boundary correctly", () => {
    renderIn(61_000);
    expect(clock()).toHaveTextContent("1:01");
    tickClock(1_000);
    expect(clock()).toHaveTextContent("1:00");
    tickClock(1_000);
    expect(clock()).toHaveTextContent("0:59");
  });

  it("reaches 0:00 and stops there (never negative)", () => {
    renderIn(2_000);
    tickClock(2_000);
    expect(clock()).toHaveTextContent("0:00");
    tickClock(30_000); // the server has not switched phase yet
    expect(clock()).toHaveTextContent("0:00");
  });

  it("marks the final 30 seconds as urgent", () => {
    renderIn(45_000);
    expect(timer()).toHaveAttribute("data-urgent", "false");
    tickClock(15_000); // 30 s remain
    expect(timer()).toHaveAttribute("data-urgent", "true");
  });

  it("exposes the remaining time to assistive tech", () => {
    renderIn(DURATION);
    expect(timer()).toHaveAttribute("role", "timer");
    expect(timer()).toHaveAccessibleName("Match time remaining: 4:00");
  });
});

describe("when the timer is shown at all", () => {
  it("renders nothing in the lobby (no deadline on the snapshot)", () => {
    render(<MatchTimer phase="aiming" deadline={null} />);
    expect(absent()).not.toBeInTheDocument();
  });

  it("renders nothing when the field is absent (older server)", () => {
    render(<MatchTimer phase="aiming" deadline={undefined} />);
    expect(absent()).not.toBeInTheDocument();
  });

  it("disappears once the match is finished", () => {
    // At/after the timeout the finished + winner UI owns the screen; a
    // countdown alongside it would be meaningless.
    render(<MatchTimer phase="finished" deadline={Date.now() + 30_000} />);
    expect(absent()).not.toBeInTheDocument();
  });

  it("keeps showing during the moving phase", () => {
    renderIn(90_000, "moving");
    expect(clock()).toHaveTextContent("1:30");
  });

  it("stops counting the moment the phase becomes finished", () => {
    const { rerender } = renderIn(30_000);
    expect(clock()).toHaveTextContent("0:30");
    rerender(<MatchTimer phase="finished" deadline={START + 30_000} />);
    expect(absent()).not.toBeInTheDocument();
  });
});

describe("it never drifts from the authoritative deadline", () => {
  it("shows the correct remaining time on a RECONNECT, immediately", () => {
    // A client that joins mid-match gets an absolute deadline and must
    // render the true remaining time on its very first frame — no
    // warm-up, no assumption that it saw the match start.
    render(<MatchTimer phase="aiming" deadline={Date.now() + 97_000} />);
    expect(clock()).toHaveTextContent("1:37");
  });

  it("re-derives from the snapshot rather than counting locally", () => {
    const { rerender } = renderIn(DURATION);
    tickClock(10_000);
    expect(clock()).toHaveTextContent("3:50");

    // The tab was suspended: wall-clock time jumped forward while no
    // interval ran. The very next sample re-derives from the deadline…
    act(() => {
      vi.setSystemTime(START + 100_000);
    });
    rerender(<MatchTimer phase="aiming" deadline={START + DURATION} />);
    tickClock(250);
    // …so the value follows the CLOCK, not the number of ticks observed:
    // a locally-counted timer would still be showing ~3:50 here.
    expect(clock()).toHaveTextContent("2:20");
  });

  it("does not jump BACKWARDS when a late snapshot arrives", () => {
    // Late/duplicate snapshots carry the SAME absolute deadline, so the
    // rendered time can only keep decreasing.
    const deadline = START + DURATION;
    const { rerender } = render(<MatchTimer phase="aiming" deadline={deadline} />);
    const readings: string[] = [];
    for (let i = 0; i < 6; i++) {
      tickClock(1_000);
      rerender(<MatchTimer phase="aiming" deadline={deadline} />); // re-push
      readings.push(clock().textContent ?? "");
    }
    expect(readings).toEqual([
      "3:59",
      "3:58",
      "3:57",
      "3:56",
      "3:55",
      "3:54",
    ]);
  });

  it("adopts a fresh deadline after a reset (a new 4 minutes)", () => {
    const { rerender } = renderIn(5_000);
    expect(clock()).toHaveTextContent("0:05");
    // Rematch: the server arms a new full-length match.
    rerender(<MatchTimer phase="aiming" deadline={Date.now() + DURATION} />);
    expect(clock()).toHaveTextContent("4:00");
  });
});

describe("render discipline", () => {
  it("updates once per second, not once per frame", () => {
    render(<MatchTimer phase="aiming" deadline={START + DURATION} />);

    // Ten seconds of wall-clock time, sampled at the component's own
    // 250 ms cadence (40 samples). The displayed value changes only when
    // the whole second changes: 10 distinct readings, not 40 — and
    // nowhere near the ~600 renders a per-frame timer would cost.
    const readings: string[] = [];
    for (let i = 0; i < 40; i++) {
      tickClock(250);
      const text = clock().textContent ?? "";
      if (readings[readings.length - 1] !== text) readings.push(text);
    }
    // 40 samples produced only 11 distinct readings — the opening 4:00
    // plus one per elapsed second.
    expect(readings).toHaveLength(11);
    expect(readings[0]).toBe("4:00");
    expect(readings[1]).toBe("3:59");
    expect(readings[10]).toBe("3:50");
  });

  it("never schedules an animation frame", () => {
    // The arena canvas has its own rAF loop; this badge must not add one.
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    renderIn(DURATION);
    tickClock(3_000);
    expect(rafSpy).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it("cleans up its interval on unmount", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderIn(DURATION);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("keeps no interval running once the match is finished", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    render(<MatchTimer phase="finished" deadline={START + DURATION} />);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});
