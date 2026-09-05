// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioControl } from "../components/game/AudioControl";
import { audio } from "../audio";

/**
 * The in-match sound control (Task 22 "UI"): renders, toggles mute,
 * adjusts the master volume, keeps the muted state accessible (labels
 * flip), persists settings, and exposes everything through native
 * button/slider roles with accessible names — keyboard operability comes
 * from the native elements themselves (jsdom does not synthesize key
 * activation, so the roles/names ARE the accessibility contract here).
 */

beforeEach(() => {
  audio.reset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  audio.reset();
  localStorage.clear();
});

function toggle() {
  return screen.getByTestId("audio-toggle");
}

function slider() {
  return screen.getByTestId("volume-slider");
}

describe("audio control", () => {
  it("renders an accessible mute button and volume slider", () => {
    render(<AudioControl />);
    expect(
      screen.getByRole("button", { name: "Mute sound" })
    ).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("🔊");
  });

  it("toggling mutes and unmutes without losing the volume", () => {
    render(<AudioControl />);
    fireEvent.click(toggle());
    expect(audio.getMuted()).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute sound" })).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("🔇");
    fireEvent.click(toggle());
    expect(audio.getMuted()).toBe(false);
    expect(audio.getVolume()).toBe(0.7); // volume untouched by muting
    expect(screen.getByRole("button", { name: "Mute sound" })).toBeInTheDocument();
  });

  it("moving the slider updates the master volume", () => {
    render(<AudioControl />);
    fireEvent.change(slider(), { target: { value: "45" } });
    expect(audio.getVolume()).toBeCloseTo(0.45, 5);
    expect((slider() as HTMLInputElement).value).toBe("45");
  });

  it("moving the slider while muted unmutes (standard UX)", () => {
    render(<AudioControl />);
    fireEvent.click(toggle());
    expect(audio.getMuted()).toBe(true);
    fireEvent.change(slider(), { target: { value: "60" } });
    expect(audio.getMuted()).toBe(false);
    expect(audio.getVolume()).toBeCloseTo(0.6, 5);
  });

  it("volume zero shows the silent state without destroying anything", () => {
    render(<AudioControl />);
    fireEvent.change(slider(), { target: { value: "0" } });
    expect(audio.getVolume()).toBe(0);
    expect(audio.getMuted()).toBe(false); // zero volume ≠ muted flag
    expect(screen.getByRole("button", { name: "Unmute sound" })).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("🔇");
    // Raising it again works immediately.
    fireEvent.change(slider(), { target: { value: "80" } });
    expect(audio.getVolume()).toBeCloseTo(0.8, 5);
    expect(toggle()).toHaveTextContent("🔊");
  });

  it("persists the settings for the next mount", () => {
    const { unmount } = render(<AudioControl />);
    fireEvent.change(slider(), { target: { value: "30" } });
    fireEvent.click(toggle());
    unmount();

    const stored = JSON.parse(localStorage.getItem("knockout-audio")!);
    expect(stored).toEqual({ muted: true, volume: 0.3 });
    // A fresh control reflects the persisted state.
    render(<AudioControl />);
    expect(screen.getByRole("button", { name: "Unmute sound" })).toBeInTheDocument();
    expect((slider() as HTMLInputElement).value).toBe("30");
  });

  it("is keyboard operable by construction (native button + range)", () => {
    render(<AudioControl />);
    const button = screen.getByRole("button", { name: "Mute sound" });
    const range = screen.getByRole("slider", { name: "Volume" });
    expect(button.tagName).toBe("BUTTON"); // Enter/Space activate natively
    expect(range.tagName).toBe("INPUT"); // arrow keys adjust natively
    expect((range as HTMLInputElement).type).toBe("range");
  });
});
