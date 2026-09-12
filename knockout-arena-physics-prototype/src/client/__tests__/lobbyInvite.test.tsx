// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  lastSent,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * Lobby invites: `?room=CODE` prefill, the top-aligned room view, and the
 * Invite button (Web Share API with a clipboard fallback).
 *
 * What these tests pin:
 *   - opening `?room=CODE` prefills the Join input (normalized, like
 *     typing) and NEVER auto-joins — the player still presses Join Room;
 *   - invalid/absent query params leave an empty input and a fully usable
 *     lobby — a bad link can never break anything;
 *   - the room view top-aligns so the code is visible without scrolling
 *     (the centered home screen is unchanged);
 *   - the Invite button shares `${origin}/?room=${code}` via navigator.share
 *     when available, else copies the link; every outcome gets small,
 *     honest feedback (a dismissed share sheet stays silent).
 *
 * All room facts come from the real server stack (in-memory socket
 * pairs); only the browser surfaces (location query, share, clipboard)
 * are stubbed.
 */

/** Point the page at a query string without navigating (jsdom-safe). */
function setQuery(search: string): void {
  window.history.replaceState({}, "", search === "" ? "/" : `/${search}`);
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

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

type ShareFn = (data: {
  title?: string;
  text?: string;
  url?: string;
}) => Promise<void>;

/** Install (or explicitly remove) the Web Share API. */
function stubShare(share: ShareFn | undefined): () => void {
  const restore = () => {
    delete (window.navigator as { share?: unknown }).share;
  };
  if (share === undefined) {
    delete (window.navigator as { share?: unknown }).share;
    return restore;
  }
  Object.defineProperty(window.navigator, "share", {
    value: share,
    configurable: true,
    writable: true,
  });
  return restore;
}

/** A rendered, connected host sitting in its freshly created room. */
async function seatedHost() {
  const harness = createServerHarness();
  const host = harness.addPlayer();
  renderLobby(host.client);
  await connectPlayer(host);
  fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
  await screen.findByTestId("room-code");
  return { harness, host };
}

describe("invite link prefill (?room=CODE)", () => {
  it("prefills the Join input and joins on demand — never automatically", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();
    await connectPlayer(host);
    await playerAct(() => host.client.createRoom());
    const code = host.client.getState().roomId as string;

    // Lowercase in the link, like a hand-typed code.
    setQuery(`?room=${code.toLowerCase()}`);
    renderLobby(guest.client);
    const pair = await connectPlayer(guest);

    expect(screen.getByLabelText("Room code")).toHaveValue(code);
    expect(screen.queryByTestId("room-panel")).toBeNull();
    expect(pair.clientSent).toHaveLength(0); // no auto-join

    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));
    expect(lastSent(pair)).toEqual({
      protocolVersion: 1,
      type: "join_room",
      roomId: code,
    });
    expect(await screen.findByTestId("room-code")).toHaveTextContent(code);
  });

  it("tolerates an encoded code with whitespace in the link", async () => {
    setQuery("?room=k7%20p4");
    const harness = createServerHarness();
    const guest = harness.addPlayer();
    renderLobby(guest.client);
    const pair = await connectPlayer(guest);

    expect(screen.getByLabelText("Room code")).toHaveValue("K7P4");
    expect(screen.queryByTestId("room-panel")).toBeNull();
    expect(pair.clientSent).toHaveLength(0);
  });

  it.each([
    ["?room=K7P0"], // 0 is excluded from the alphabet
    ["?room=K7PI"], // I is excluded from the alphabet
    ["?room=AB"],
    ["?room=ABCDE"],
    ["?room="],
    ["?room=%21%21%21"], // !!!
    ["?foo=bar"],
    [""],
  ])("invalid query %s leaves an empty input and a usable lobby", async (search) => {
    setQuery(search);
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    const pair = await connectPlayer(player);

    expect(screen.getByLabelText("Room code")).toHaveValue("");
    expect(screen.queryByTestId("room-panel")).toBeNull();
    expect(pair.clientSent).toHaveLength(0);

    // Still fully usable: creating a room works.
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    expect(await screen.findByTestId("room-panel")).toBeInTheDocument();
  });
});

describe("room code visibility", () => {
  it("top-aligns the room view so the code needs no scroll (home stays centered)", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    const main = screen.getByRole("main");
    expect(main.className).toContain("items-center"); // home: centered

    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    await screen.findByTestId("room-code");
    expect(main.className).toContain("items-start"); // room: top-aligned
    expect(main.className).not.toContain("items-center");
  });
});

describe("Invite button", () => {
  it("shows an Invite button next to the room code, Copy Code intact", async () => {
    await seatedHost();

    const invite = screen.getByTestId("invite-button");
    expect(invite).toHaveTextContent("Invite");
    expect(invite).toBeEnabled();
    expect(screen.getByTestId("invite-feedback")).toHaveTextContent("");
    expect(screen.getByTestId("copy-code")).toHaveTextContent("Copy Code");
  });

  it("shares the invite URL via the Web Share API when available", async () => {
    const share = vi.fn<ShareFn>().mockResolvedValue(undefined);
    const restoreShare = stubShare(share);
    try {
      const { host } = await seatedHost();
      const code = host.client.getState().roomId as string;
      const expectedUrl = `${window.location.origin}/?room=${code}`;

      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByTestId("invite-button"));
        await act(async () => {}); // flush the share promise
        expect(share).toHaveBeenCalledTimes(1);
        expect(share).toHaveBeenCalledWith(
          expect.objectContaining({ url: expectedUrl })
        );
        expect(screen.getByTestId("invite-feedback")).toHaveTextContent(
          "Shared!"
        );

        // The feedback is short-lived: it reverts after the delay.
        act(() => {
          vi.advanceTimersByTime(1_600);
        });
        expect(screen.getByTestId("invite-feedback")).toHaveTextContent("");
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restoreShare();
    }
  });

  it("stays silent when the user dismisses the share sheet", async () => {
    const share = vi
      .fn<ShareFn>()
      .mockRejectedValue(new DOMException("dismissed", "AbortError"));
    const restoreShare = stubShare(share);
    try {
      await seatedHost();

      fireEvent.click(screen.getByTestId("invite-button"));
      await act(async () => {});
      expect(share).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("invite-feedback")).toHaveTextContent("");
    } finally {
      restoreShare();
    }
  });

  it("shows an error when sharing fails", async () => {
    const share = vi.fn<ShareFn>().mockRejectedValue(new Error("nope"));
    const restoreShare = stubShare(share);
    try {
      await seatedHost();

      fireEvent.click(screen.getByTestId("invite-button"));
      await act(async () => {});
      expect(screen.getByTestId("invite-feedback")).toHaveTextContent(
        "Couldn't share invite"
      );
    } finally {
      restoreShare();
    }
  });

  it("without Web Share, copies the invite link to the clipboard", async () => {
    const restoreShare = stubShare(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = stubClipboard(writeText);
    try {
      const { host } = await seatedHost();
      const code = host.client.getState().roomId as string;

      fireEvent.click(screen.getByTestId("invite-button"));
      await act(async () => {});
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/?room=${code}`
      );
      expect(screen.getByTestId("invite-feedback")).toHaveTextContent(
        "Link copied!"
      );
    } finally {
      restoreClipboard();
      restoreShare();
    }
  });

  it("shows an error when every invite copy path fails", async () => {
    const restoreShare = stubShare(undefined);
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const restoreClipboard = stubClipboard(writeText);
    const execCommand = vi.fn((): boolean => false);
    document.execCommand = execCommand as unknown as typeof document.execCommand;
    try {
      await seatedHost();

      fireEvent.click(screen.getByTestId("invite-button"));
      await act(async () => {});
      expect(execCommand).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("invite-feedback")).toHaveTextContent(
        "Couldn't share invite"
      );
    } finally {
      restoreClipboard();
      restoreShare();
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });
});
