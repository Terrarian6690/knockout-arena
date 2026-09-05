// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  lastSent,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * Lobby room-code UX: the short, player-facing locator.
 *
 * What these tests pin:
 *   - the room screen shows a prominent ROOM CODE and NEVER the internal
 *     room id (the welcome only ever carries the code);
 *   - Copy Code puts the code on the clipboard and flashes "Copied!",
 *     which reverts after a short delay (both the async Clipboard API
 *     path and the legacy execCommand fallback for plain-http previews);
 *   - the join input uppercases as the player types and normalizes on
 *     submit ("k7 p4" → "K7P4" on the wire);
 *   - malformed codes are a local, instant error — nothing is sent and
 *     nothing about which rooms exist is asked of the server.
 *
 * All room facts come from the real server stack (in-memory socket
 * pairs); no server behavior is mocked.
 */

const UUID_RE = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;

/** Replace navigator.clipboard (jsdom has none) with a controllable stub. */
function stubClipboard(
  writeText: ((text: string) => Promise<void>) | undefined
): () => void {
  Object.defineProperty(window.navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
    writable: true,
  });
  return () => {
    delete (window.navigator as { clipboard?: unknown }).clipboard;
  };
}

/** A rendered, connected host sitting in its freshly created room. */
async function seatedHost() {
  const harness = createServerHarness();
  const host = harness.addPlayer();
  renderLobby(host.client);
  await connectPlayer(host);
  fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
  const code = await screen.findByTestId("room-code");
  return { harness, host, codeEl: code };
}

describe("lobby room code UX", () => {
  it("shows the prominent room code — and never the internal room id", async () => {
    const { harness, host, codeEl } = await seatedHost();
    const code = host.client.getState().roomId as string;
    expect(codeEl).toHaveTextContent(code);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);

    // The share hint points at the code, not an id.
    expect(
      screen.getByText("Share this code so others can join")
    ).toBeInTheDocument();
    expect(screen.getByText("Room code")).toBeInTheDocument();

    // The internal id exists server-side… and appears nowhere in the UI.
    const room = harness.gameServer.getRoom(code);
    expect(room).not.toBeNull();
    const internalId = room!.id;
    const body = document.body.textContent ?? "";
    expect(body).not.toContain(internalId);
    expect(body).not.toMatch(UUID_RE);
    expect(screen.queryByTestId("room-id")).toBeNull();
  });

  it("Copy Code copies the code and flashes Copied! briefly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restore = stubClipboard(writeText);
    try {
      const { host } = await seatedHost();
      const code = host.client.getState().roomId as string;
      expect(screen.getByTestId("copy-feedback")).toHaveTextContent("");

      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByTestId("copy-code"));
        await act(async () => {}); // flush the clipboard promise
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(code);
        expect(screen.getByTestId("copy-feedback")).toHaveTextContent(
          "Copied!"
        );

        // The feedback is short-lived: it reverts after the delay.
        act(() => {
          vi.advanceTimersByTime(1_600);
        });
        expect(screen.getByTestId("copy-feedback")).toHaveTextContent("");
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restore();
    }
  });

  it("Copy Code falls back to execCommand when the Clipboard API is absent", async () => {
    const restoreClipboard = stubClipboard(undefined); // plain-http preview
    const staged: string[] = [];
    const originalSelect = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = function (this: HTMLTextAreaElement) {
      staged.push(this.value); // jsdom's select() is a no-op; record instead
    };
    const execCommand = vi.fn((): boolean => true);
    document.execCommand = execCommand as unknown as typeof document.execCommand;
    try {
      const { host } = await seatedHost();
      const code = host.client.getState().roomId as string;

      fireEvent.click(screen.getByTestId("copy-code"));
      await act(async () => {});
      expect(execCommand).toHaveBeenCalledTimes(1);
      // The fallback staged exactly the code for copying.
      expect(staged).toEqual([code]);
      expect(screen.getByTestId("copy-feedback")).toHaveTextContent("Copied!");
    } finally {
      restoreClipboard();
      HTMLTextAreaElement.prototype.select = originalSelect;
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });

  it("uppercases the input while typing and normalizes the code on join", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();
    renderLobby(guest.client);
    const pair = await connectPlayer(guest);

    // The host creates a room headless; its code is what the guest joins by.
    await connectPlayer(host);
    await act(async () => {
      host.client.createRoom();
    });
    const code = host.client.getState().roomId as string;

    const input = screen.getByLabelText("Room code");
    // Typing lowercase shows uppercase immediately…
    fireEvent.change(input, { target: { value: code.toLowerCase() } });
    expect(input).toHaveValue(code);
    // …and whitespace is tolerated: kept while typing, stripped on submit.
    fireEvent.change(input, {
      target: { value: ` ${code.slice(0, 2).toLowerCase()} ${code.slice(2)} ` },
    });
    expect(input).toHaveValue(` ${code.slice(0, 2)} ${code.slice(2)} `);
    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    // Exactly the normalized code goes on the wire.
    expect(lastSent(pair)).toEqual({
      protocolVersion: 1,
      type: "join_room",
      roomId: code,
    });
    // The guest lands in the room, seeing the same code.
    expect(await screen.findByTestId("room-code")).toHaveTextContent(code);
    expect(screen.getByTestId("local-player-id")).toHaveTextContent("p1");
  });

  it("Enter submits a lowercase code too (normalized before sending)", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();
    renderLobby(guest.client);
    const pair = await connectPlayer(guest);
    await connectPlayer(host);
    await act(async () => {
      host.client.createRoom();
    });
    const code = host.client.getState().roomId as string;

    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: code.toLowerCase() },
    });
    fireEvent.keyDown(screen.getByLabelText("Room code"), { key: "Enter" });

    expect(lastSent(pair)).toEqual({
      protocolVersion: 1,
      type: "join_room",
      roomId: code,
    });
    expect(await screen.findByTestId("room-code")).toHaveTextContent(code);
  });

  it("rejects malformed codes locally: instant error, nothing sent", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    const pair = await connectPlayer(player);

    for (const bad of ["K7P0", "K7PI", "AB", "ABCDE", "code"]) {
      fireEvent.change(screen.getByLabelText("Room code"), {
        target: { value: bad },
      });
      fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

      // Local, instant, specific feedback — no server round-trip.
      const error = screen.getByTestId("join-error");
      expect(error).toHaveTextContent(/4 characters/);
      expect(screen.queryByTestId("room-panel")).toBeNull();
    }
    // Not a single join_room left the client (the connection handshake
    // sends nothing).
    expect(pair.clientSent).toHaveLength(0);

    // Typing again clears the error.
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: "K7P" },
    });
    expect(screen.queryByTestId("join-error")).toBeNull();
  });
});
