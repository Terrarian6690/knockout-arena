// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import App from "../App";

/**
 * App-level smoke test: the real shell (no injected anything) boots into
 * the multiplayer lobby, keeps the solo prototype reachable, and switches
 * between the two modes without crashing.
 *
 * jsdom actually ships a WebSocket implementation whose connections fail
 * asynchronously; to pin the "app boots where no game server (and here: no
 * WebSocket at all) exists" scenario deterministically, we remove it — the
 * provider's auto-connect must then fail cleanly (no crash) and the lobby
 * must show Disconnected with solo practice still available.
 */

// React act() support for a non-global test setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** jsdom ships neither ResizeObserver (used by useGame) nor… */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (window as unknown as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
  // …a WebSocket we want to rely on here; see the file comment.
  delete (window as { WebSocket?: unknown }).WebSocket;
});

afterEach(cleanup);

describe("app shell", () => {
  it("boots into the lobby (initial screen with connection status)", () => {
    render(<App />);

    expect(screen.getByText("Multiplayer lobby")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Room" })).toBeDisabled();
    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Disconnected"
    );
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("practice solo mounts the original single-player app and back", async () => {
    render(<App />);

    // Enter solo mode (the lobby's escape hatch).
    fireEvent.click(screen.getByRole("button", { name: /Practice solo/ }));

    // The original app renders: canvas arena and the launch controls.
    expect(
      await screen.findByRole("button", { name: "Launch" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(document.querySelector("canvas")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Create Room" })).toBeNull();

    // …and the way back to the lobby works.
    fireEvent.click(screen.getByRole("button", { name: /Lobby/ }));
    expect(
      await screen.findByRole("button", { name: "Create Room" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
  });

  it("the lobby without a server never throws and stays coherent", () => {
    render(<App />);

    // The reconnect affordance goes through the network client; with no
    // WebSocket implementation it fails cleanly and the UI stays usable.
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Disconnected"
    );
    expect(screen.getByRole("button", { name: "Create Room" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Practice solo/ })).toBeEnabled();
  });
});
