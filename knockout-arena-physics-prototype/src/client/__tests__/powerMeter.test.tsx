// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PowerMeter } from "../components/game/PowerMeter";

// React act() support for a non-global test setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  cleanup(); // no vitest globals → manual RTL cleanup
});

/**
 * The power selector: a GROWING ARROW (thin green tail → wide red head)
 * with five discrete points on it.
 *
 * The visual changed completely in Task 21; the contract did not. These
 * tests pin the contract that must survive any future re-skin:
 *
 *   - five discrete integer levels 1–5, each a plain keyboard-operable
 *     button named "Power N" (Tab / Enter / Space, no custom keys
 *     required) — never a continuous slider;
 *   - role="group" + aria-label="Power" on the container;
 *   - aria-pressed marks exactly the selected level;
 *   - arrow keys move AND select between the five points;
 *   - the selection is shown by more than colour;
 *   - clicking selects; disabled locks the control but keeps the choice
 *     readable. Values and the setPower intent are unchanged.
 */
describe("power meter — the accessibility contract", () => {
  it("is a labelled group", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);
    const group = screen.getByTestId("power-meter");
    expect(group).toHaveAttribute("role", "group");
    expect(group).toHaveAttribute("aria-label", "Power");
    // Reachable by its accessible name, not just its test id.
    expect(screen.getByRole("group", { name: "Power" })).toBe(group);
  });

  it("renders exactly the five integer levels as plain buttons", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);

    const buttons = screen.getAllByRole("button", { name: /^Power [1-5]$/ });
    expect(buttons).toHaveLength(5);
    buttons.forEach((button, index) => {
      expect(button).toHaveTextContent(String(index + 1));
      // Native buttons: keyboard-operable by construction.
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
    });

    // In scale order: 1 … 5 along the arrow.
    const group = screen.getByTestId("power-meter");
    const order = Array.from(
      group.querySelectorAll('[data-testid^="power-level-"]')
    ).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "power-level-1",
      "power-level-2",
      "power-level-3",
      "power-level-4",
      "power-level-5",
    ]);
  });

  it("is a discrete five-value control, not a continuous slider", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);
    // No range input and no slider role could smuggle in fractional values.
    const group = screen.getByTestId("power-meter");
    expect(group.querySelector('input[type="range"]')).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    // Exactly five interactive controls, no more.
    expect(group.querySelectorAll("button")).toHaveLength(5);
  });

  it("marks exactly the selected level with aria-pressed", () => {
    render(<PowerMeter power={4} onChange={() => {}} />);
    for (const level of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`power-level-${level}`)).toHaveAttribute(
        "aria-pressed",
        level === 4 ? "true" : "false"
      );
    }
    expect(
      screen.getAllByRole("button", { pressed: true }).map((b) => b.textContent)
    ).toEqual(["4"]);
  });

  it("moves and selects with the arrow keys", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={3} onChange={onChange} />);
    const third = screen.getByTestId("power-level-3");
    third.focus();

    fireEvent.keyDown(third, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(4);
    // Focus follows the selection, so the next key continues from there.
    expect(document.activeElement).toBe(screen.getByTestId("power-level-4"));

    fireEvent.keyDown(screen.getByTestId("power-level-4"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(3);
    expect(document.activeElement).toBe(screen.getByTestId("power-level-3"));
  });

  it("supports Home and End, and does not run off either end", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={3} onChange={onChange} />);

    fireEvent.keyDown(screen.getByTestId("power-level-3"), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(screen.getByTestId("power-level-5"), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(1);

    // At the ends, the extra key press is a no-op rather than a wrap or
    // an out-of-range value.
    onChange.mockClear();
    fireEvent.keyDown(screen.getByTestId("power-level-1"), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("power-level-5"), {
      key: "ArrowRight",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves other keys to the browser (Tab/Enter/Space still native)", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={3} onChange={onChange} />);
    const third = screen.getByTestId("power-level-3");
    for (const key of ["Tab", "a", "Escape"]) {
      fireEvent.keyDown(third, { key });
    }
    expect(onChange).not.toHaveBeenCalled();
    // Enter/Space activate the button itself — a click, natively.
    fireEvent.click(third);
    expect(onChange).toHaveBeenCalledWith(3);
  });
});

describe("power meter — the growing gradient arrow", () => {
  it("draws one arrow whose gradient runs green → red", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);

    // The arrow is decorative: the buttons carry all the semantics.
    const svg = screen.getByTestId("power-arrow");
    expect(svg).toHaveAttribute("aria-hidden", "true");

    // One continuous gradient across the whole shape, weak → strong.
    const stops = Array.from(svg.querySelectorAll("stop"));
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops[0]).toHaveAttribute("stop-color", "#22c55e"); // green
    expect(stops[stops.length - 1]).toHaveAttribute("stop-color", "#ef4444"); // red
    // Offsets ascend, so the ramp never doubles back.
    const offsets = stops.map((s) =>
      Number.parseFloat(s.getAttribute("offset")!.replace("%", ""))
    );
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));

    // The shape is filled BY that gradient (not a flat colour).
    const shape = screen.getByTestId("power-arrow-shape");
    const gradientId = svg.querySelector("linearGradient")!.getAttribute("id");
    expect(shape.getAttribute("fill")).toBe(`url(#${gradientId})`);
  });

  it("widens from tail to head and comes to a point", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);
    const points = screen
      .getByTestId("power-arrow-shape")
      .getAttribute("points")!
      .split(" ")
      .map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x: x!, y: y! };
      });

    // The centre line: the arrow is symmetric about it, so it is the
    // mean of the extremes (NOT half the max — the barbs overhang the
    // shaft, so the shape's extremes are not the viewBox's).
    const ys = points.map((p) => p.y);
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    /** Half-height of the shape at a given x (0 where it is a point). */
    const halfHeightAt = (x: number) =>
      Math.max(
        ...points.filter((p) => Math.abs(p.x - x) < 1).map((p) => Math.abs(p.y - midY)),
        0
      );

    const tailX = Math.min(...points.map((p) => p.x));
    const tipX = Math.max(...points.map((p) => p.x));
    // The tail is narrow, the head is wider: the shape GROWS.
    const shaftEndX = Math.max(
      ...points.filter((p) => p.x < tipX).map((p) => p.x)
    );
    expect(halfHeightAt(shaftEndX)).toBeGreaterThan(halfHeightAt(tailX));
    // …and ends in a single point on the centre line (the arrow tip).
    const tip = points.filter((p) => Math.abs(p.x - tipX) < 1);
    expect(tip).toHaveLength(1);
    expect(tip[0]!.y).toBeCloseTo(midY, 5);
  });

  it("places the five points in ascending order along the arrow", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);
    const lefts = [1, 2, 3, 4, 5].map((level) =>
      Number.parseFloat(screen.getByTestId(`power-level-${level}`).style.left)
    );
    // Strictly increasing: power 1 nearest the tail, power 5 nearest the tip.
    for (let i = 1; i < lefts.length; i += 1) {
      expect(lefts[i]!).toBeGreaterThan(lefts[i - 1]!);
    }
    // Evenly spaced along the shaft.
    const gaps = lefts.slice(1).map((left, i) => left - lefts[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 5);
    // All of them sit within the arrow, not outside it.
    expect(lefts[0]!).toBeGreaterThan(0);
    expect(lefts[lefts.length - 1]!).toBeLessThan(100);
  });

  it("grows the points with the shaft so each stays on the arrow", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);
    const sizes = [1, 2, 3, 4, 5].map((level) =>
      Number.parseFloat(screen.getByTestId(`power-level-${level}`).style.width)
    );
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
    }
    expect(sizes[4]!).toBeGreaterThan(sizes[0]!);
  });

  it("makes the selected power obvious by more than colour", () => {
    render(<PowerMeter power={4} onChange={() => {}} />);
    const tokens = (el: HTMLElement) => el.className.split(/\s+/);

    const current = screen.getByTestId("power-level-4");
    expect(current).toHaveAttribute("aria-pressed", "true");
    // Inverted chip + ring + raised: three non-colour cues.
    expect(tokens(current)).toContain("bg-white");
    expect(tokens(current)).toContain("text-black");
    expect(tokens(current)).toContain("ring-2");
    expect(tokens(current)).toContain("scale-125");
    // …and the number is still legible in it.
    expect(current).toHaveTextContent("4");

    for (const level of [1, 2, 3, 5]) {
      const other = screen.getByTestId(`power-level-${level}`);
      expect(other).toHaveAttribute("aria-pressed", "false");
      expect(tokens(other)).not.toContain("scale-125");
      expect(tokens(other)).not.toContain("bg-white");
    }
  });
});

describe("power meter — selection behaviour", () => {
  it("selects the clicked level", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={2} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Power 5" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it("reports every level exactly, 1 through 5", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={3} onChange={onChange} />);
    for (const level of [1, 2, 3, 4, 5]) {
      fireEvent.click(screen.getByRole("button", { name: `Power ${level}` }));
    }
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([1, 2, 3, 4, 5]);
    // Integers only — nothing fractional can escape this control.
    for (const [value] of onChange.mock.calls) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("locks the control when disabled but keeps the choice readable", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={5} onChange={onChange} disabled />);

    for (const level of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`power-level-${level}`)).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "Power 1" }));
    expect(onChange).not.toHaveBeenCalled();

    // The locked choice is still shown, not hidden.
    const current = screen.getByTestId("power-level-5");
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(current).toHaveTextContent("5");
    // The arrow itself stays on screen too.
    expect(screen.getByTestId("power-arrow")).toBeInTheDocument();
  });
});
