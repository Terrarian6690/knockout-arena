// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterMobileFullscreen,
  exitMobileFullscreen,
} from "../mobileFullscreen";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * Hiding the phone browser's address bar while playing: the FIRST touch
 * inside the match screen is the user gesture that requests fullscreen
 * (phones only — coarse pointers; desktops are never touched). Leaving
 * the match screen hands the chrome back.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubPointer(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches, query }));
}

function stubFullscreenApi() {
  const requestFullscreen = vi.fn().mockResolvedValue(undefined);
  const exitFullscreen = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    value: requestFullscreen,
    configurable: true,
  });
  Object.defineProperty(document, "exitFullscreen", {
    value: exitFullscreen,
    configurable: true,
  });
  Object.defineProperty(document, "fullscreenEnabled", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(document, "fullscreenElement", {
    value: null,
    configurable: true,
  });
  return { requestFullscreen, exitFullscreen };
}

describe("enterMobileFullscreen (the gesture helper)", () => {
  it("requests fullscreen with navigationUI hidden on a phone", async () => {
    stubPointer(true);
    const api = stubFullscreenApi();
    const entered = await enterMobileFullscreen();
    expect(entered).toBe(true);
    expect(api.requestFullscreen).toHaveBeenCalledWith({
      navigationUI: "hide",
    });
  });

  it("never touches fullscreen on a fine-pointer (desktop) device", async () => {
    stubPointer(false);
    const api = stubFullscreenApi();
    expect(await enterMobileFullscreen()).toBe(false);
    expect(api.requestFullscreen).not.toHaveBeenCalled();
  });

  it("swallows a refused request instead of breaking the caller", async () => {
    stubPointer(true);
    stubFullscreenApi();
    vi.spyOn(document.documentElement, "requestFullscreen").mockRejectedValue(
      new Error("denied")
    );
    await expect(enterMobileFullscreen()).resolves.toBe(false);
  });

  it("exit is a no-op when fullscreen is not engaged", () => {
    stubPointer(true);
    const api = stubFullscreenApi();
    expect(() => exitMobileFullscreen()).not.toThrow();
    expect(api.exitFullscreen).not.toHaveBeenCalled();
  });
});

describe("the match screen's first-touch fullscreen (phones)", () => {
  async function renderGame() {
    const { client, sockets } = createScriptedClient();
    const view = render(
      <NetworkProvider client={client}>
        <MultiplayerGame onLeave={() => client.leaveRoom()} />
      </NetworkProvider>
    );
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
    });
    await act(async () => {
      sockets[0].serverMessage(wire.snapshot({}));
    });
    return { client, sockets, unmount: view.unmount };
  }

  it("the first tap asks for fullscreen, exactly once per mount", async () => {
    stubPointer(true);
    const api = stubFullscreenApi();
    const { unmount } = await renderGame();

    const root = screen.getByTestId("multiplayer-game");
    await act(async () => {
      fireEvent.pointerDown(root);
    });
    expect(api.requestFullscreen).toHaveBeenCalledTimes(1);

    // Later touches: the request is already in flight — no repeats.
    await act(async () => {
      fireEvent.pointerDown(root);
    });
    expect(api.requestFullscreen).toHaveBeenCalledTimes(1);

    // Leaving the match screen hands the browser chrome back.
    await act(async () => {
      Object.defineProperty(document, "fullscreenElement", {
        value: document.documentElement,
        configurable: true,
      });
      unmount();
    });
    expect(api.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("a desktop tap never requests fullscreen", async () => {
    stubPointer(false);
    const api = stubFullscreenApi();
    await renderGame();
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("multiplayer-game"));
    });
    expect(api.requestFullscreen).not.toHaveBeenCalled();
  });
});
