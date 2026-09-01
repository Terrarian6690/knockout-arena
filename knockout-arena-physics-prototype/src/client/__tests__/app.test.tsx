// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("solo mode still runs the local engine (aim → launch → moving)", async () => {
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Practice solo/ }));

    // Local engine behavior, unchanged: pointer aim + launch drive the
    // phase machine right here in the browser — no server involved.
    const canvas = document.querySelector("canvas");
    expect(canvas).not.toBeNull();
    fireEvent.pointerDown(canvas!, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(
      await screen.findByText("In motion…", {}, { timeout: 5000 })
    ).toBeInTheDocument();

    view.unmount();
  });

  it("solo mode does not use the multiplayer network", async () => {
    // A stand-in environment socket that records constructions and closes.
    let constructed = 0;
    let closed = 0;
    class CountingWebSocket {
      constructor(_url: string | URL) {
        constructed += 1;
      }
      close(): void {
        closed += 1;
      }
      send(): void {}
      onopen: unknown = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      onclose: unknown = null;
    }
    const env = window as unknown as { WebSocket?: unknown };
    env.WebSocket = CountingWebSocket;
    try {
      const view = render(<App />);
      // Booting the lobby opened exactly one connection…
      await waitFor(() => expect(constructed).toBe(1));
      // …and entering solo mode tears the network down entirely.
      fireEvent.click(screen.getByRole("button", { name: /Practice solo/ }));
      expect(
        await screen.findByRole("button", { name: "Launch" })
      ).toBeInTheDocument();
      expect(closed).toBe(1);
      // No further networking happens while playing solo.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 120));
      });
      expect(constructed).toBe(1);
      view.unmount();
    } finally {
      delete env.WebSocket; // back to the no-WebSocket environment
    }
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
