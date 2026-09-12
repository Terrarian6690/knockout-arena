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
 * The multiplayer power meter: a horizontal gradient ARROW (low → high),
 * tip at power 5. Pins the redesign's contract:
 *
 *   - five discrete integer levels 1–5, each a plain keyboard-operable
 *     button named "Power N" (Tab / Enter / Space, no custom keys);
 *   - one continuous green→red gradient shaft with the arrowhead tip
 *     AFTER power 5 in DOM order;
 *   - the selected level unmissable (aria-pressed + ring + inverted chip);
 *   - clicking selects; disabled locks the control but keeps the choice
 *     readable. Values and the setPower intent are unchanged.
 */
describe("power meter arrow", () => {
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
    // In scale order: 1 … 5 along the shaft.
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

  it("draws one horizontal gradient shaft with the tip at power 5", () => {
    render(<PowerMeter power={3} onChange={() => {}} />);

    // The shaft behind the segments: a single left-to-right gradient
    // running the weak→strong scale (green … red).
    const shaft = screen
      .getByTestId("power-level-3")
      .parentElement as HTMLElement;
    expect(shaft.style.background).toContain("linear-gradient(to right");
    // (jsdom serializes the stops as rgb(): green … red.)
    expect(shaft.style.background).toContain("rgb(34, 197, 94)"); // weak end
    expect(shaft.style.background).toContain("rgb(239, 68, 68)"); // strong end

    // The arrowhead tip comes AFTER power 5 in DOM order.
    const meter = screen.getByTestId("power-meter");
    const children = Array.from(meter.children);
    expect(children).toHaveLength(2);
    expect(children[1]).toHaveAttribute("data-testid", "power-meter-cap");
    expect(children[1]).toHaveAttribute("aria-hidden", "true");
  });

  it("makes the selected power obvious", () => {
    render(<PowerMeter power={4} onChange={() => {}} />);

    // (Token-exact: the focus-visible:ring-2 utility contains the
    // substring on every button, so compare whole class tokens.)
    const tokens = (el: HTMLElement) => el.className.split(/\s+/);
    const current = screen.getByTestId("power-level-4");
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(tokens(current)).toContain("ring-2"); // the white ring
    const chip = current.querySelector("span:last-child") as HTMLElement;
    expect(chip.className).toContain("bg-white"); // inverted chip
    expect(chip.className).toContain("text-black");

    // Every other level reads as unselected.
    for (const level of [1, 2, 3, 5]) {
      const other = screen.getByTestId(`power-level-${level}`);
      expect(other).toHaveAttribute("aria-pressed", "false");
      expect(tokens(other)).not.toContain("ring-2");
    }
  });

  it("selects the clicked level", () => {
    const onChange = vi.fn();
    render(<PowerMeter power={2} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Power 5" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(5);
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
  });
});
