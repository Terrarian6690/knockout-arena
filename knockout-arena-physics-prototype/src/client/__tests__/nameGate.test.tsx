// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DISPLAY_NAME_LENGTH } from "../network/displayName";
import {
  allSent,
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * THE NAME GATE (Task 20): a player must choose a name before playing.
 *
 * The rule is enforced at every entrance — Quick Play, Create Room and
 * Join by code — and it is enforced on the WIRE, not just in the UI:
 * these tests assert that a blocked click sends nothing at all, so a
 * cosmetic "disabled" attribute could not pass them.
 *
 * The validation rule itself is not reinvented: the gate reuses
 * normalizeDisplayName, the same function the SERVER validates with
 * (src/server/displayName.ts, mirrored client-side), so the two can
 * never disagree about what a name is.
 *
 * Everything runs against the real server through in-memory sockets.
 */

afterEach(() => {
  cleanup();
});

/** A rendered, connected player who has NOT chosen a name. */
async function unnamedPlayer() {
  const harness = createServerHarness();
  const player = harness.addPlayer();
  const pair = await connectPlayer(player);
  renderLobby(player.client, { playerName: null });
  return { harness, player, pair };
}

const nameBox = () => screen.getByTestId("player-name-input");
const quickPlay = () => screen.getByTestId("join-public");
const createRoom = () => screen.getByRole("button", { name: "Create Room" });
const joinRoom = () => screen.getByRole("button", { name: "Join Room" });

function typeName(value: string) {
  fireEvent.change(nameBox(), { target: { value } });
}

describe("without a name, no entrance opens", () => {
  it("Quick Play is blocked and says why", async () => {
    const { pair } = await unnamedPlayer();

    await act(async () => {
      fireEvent.click(quickPlay());
    });

    // Nothing reached the wire…
    expect(allSent(pair)).toEqual([]);
    // …and the refusal is explained, not silent.
    const error = screen.getByTestId("name-required-error");
    expect(error).toHaveTextContent(/choose a name/i);
    expect(error).toHaveAttribute("role", "alert");
  });

  it("Create Room is blocked and says why", async () => {
    const { pair } = await unnamedPlayer();

    await act(async () => {
      fireEvent.click(createRoom());
    });

    expect(allSent(pair)).toEqual([]);
    expect(screen.getByTestId("name-required-error")).toHaveTextContent(
      /choose a name/i
    );
  });

  it("Join by code is blocked even with a perfectly valid code", async () => {
    const { harness, pair } = await unnamedPlayer();
    // A real, joinable room exists — only the missing name stops us.
    const host = harness.addPlayer();
    await connectPlayer(host);
    await act(async () => {
      host.client.createRoom();
    });
    const code = host.client.getState().roomId as string;

    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: code },
    });
    await act(async () => {
      fireEvent.click(joinRoom());
    });

    expect(allSent(pair)).toEqual([]);
    expect(screen.getByTestId("name-required-error")).toBeInTheDocument();
  });

  it("no room is ever entered", async () => {
    const { player } = await unnamedPlayer();
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    expect(player.client.getState().roomId).toBeNull();
    expect(screen.queryByTestId("room-panel")).toBeNull();
  });

  it("sends focus to the name box so the block is not a dead end", async () => {
    await unnamedPlayer();
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    expect(document.activeElement).toBe(nameBox());
  });

  it("advertises the requirement before anything is clicked", async () => {
    await unnamedPlayer();
    // The field is marked required and the buttons point at the reason.
    expect(nameBox()).toBeRequired();
    expect(nameBox()).toHaveAttribute("aria-required", "true");
    expect(screen.getByTestId("name-gate-hint")).toHaveTextContent(
      /enter a name/i
    );
    expect(quickPlay()).toHaveAttribute("aria-describedby", "name-gate-hint");
    expect(createRoom()).toHaveAttribute("aria-describedby", "name-gate-hint");
  });

  it("whitespace alone is not a name", async () => {
    const { pair } = await unnamedPlayer();
    typeName("     ");
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    expect(allSent(pair)).toEqual([]);
    expect(screen.getByTestId("name-required-error")).toBeInTheDocument();
  });

  it("rejects names the SERVER would reject, with the shape explained", async () => {
    const { pair } = await unnamedPlayer();

    for (const bad of ["A".repeat(MAX_DISPLAY_NAME_LENGTH + 1), "A\tB"]) {
      typeName(bad);
      await act(async () => {
        fireEvent.click(quickPlay());
      });
      expect(allSent(pair)).toEqual([]);
      expect(screen.getByTestId("name-required-error")).toHaveTextContent(
        /characters/i
      );
    }
  });
});

describe("with a valid name, every entrance works", () => {
  it("Quick Play goes through and names the seat", async () => {
    const { player, pair } = await unnamedPlayer();
    typeName("Ada");

    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    expect(allSent(pair).map((m) => m.type)).toEqual([
      "join_public",
      "set_name",
    ]);
    // The chosen name is what the server now holds for the seat.
    await waitFor(() =>
      expect(screen.getByTestId("seat-p0")).toHaveTextContent("Ada")
    );
    expect(screen.queryByTestId("name-required-error")).toBeNull();
  });

  it("Create Room goes through and names the seat", async () => {
    const { player, pair } = await unnamedPlayer();
    typeName("Grace");

    await act(async () => {
      fireEvent.click(createRoom());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    expect(allSent(pair).map((m) => m.type)).toEqual([
      "create_room",
      "set_name",
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("seat-p0")).toHaveTextContent("Grace")
    );
  });

  it("Join by code goes through and names the seat", async () => {
    const { harness, player, pair } = await unnamedPlayer();
    const host = harness.addPlayer();
    await connectPlayer(host);
    await act(async () => {
      host.client.createRoom();
    });
    const code = host.client.getState().roomId as string;

    typeName("Linus");
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: code },
    });
    await act(async () => {
      fireEvent.click(joinRoom());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    expect(allSent(pair).map((m) => m.type)).toEqual(["join_room", "set_name"]);
    await waitFor(() =>
      expect(screen.getByTestId("seat-p1")).toHaveTextContent("Linus")
    );
  });

  it("trims the name the way the server would", async () => {
    const { player, pair } = await unnamedPlayer();
    typeName("   Ada   ");
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    const setName = allSent(pair).find((m) => m.type === "set_name");
    expect(setName).toEqual({
      protocolVersion: 1,
      type: "set_name",
      name: "Ada",
    });
  });

  it("accepts Unicode names within the length rule", async () => {
    const { player, pair } = await unnamedPlayer();
    typeName("Żółć");
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());
    expect(allSent(pair).map((m) => m.type)).toContain("set_name");
    await waitFor(() =>
      expect(screen.getByTestId("seat-p0")).toHaveTextContent("Żółć")
    );
  });

  it("clears the refusal as soon as a name is typed", async () => {
    await unnamedPlayer();
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    expect(screen.getByTestId("name-required-error")).toBeInTheDocument();

    typeName("Ada");
    expect(screen.queryByTestId("name-required-error")).toBeNull();
    expect(screen.queryByTestId("name-gate-hint")).toBeNull();
  });

  it("bounds the field so a pasted novel cannot get in", async () => {
    await unnamedPlayer();
    expect(nameBox()).toHaveAttribute(
      "maxlength",
      String(2 * MAX_DISPLAY_NAME_LENGTH)
    );
  });
});

describe("the name carries through the session", () => {
  it("renaming in the room keeps the two boxes in agreement", async () => {
    const { player } = await unnamedPlayer();
    typeName("Ada");
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    // Rename from inside the room…
    fireEvent.change(screen.getByTestId("display-name-input"), {
      target: { value: "Grace" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-name"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("seat-p0")).toHaveTextContent("Grace")
    );

    // …leave, and the home screen remembers the latest name, so the
    // player is not asked again.
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });
    await waitFor(() => expect(nameBox()).toBeInTheDocument());
    expect(nameBox()).toHaveValue("Grace");
    expect(screen.queryByTestId("name-gate-hint")).toBeNull();
  });

  it("re-entering after leaving needs no re-typing and re-names the seat", async () => {
    const { player, pair } = await unnamedPlayer();
    typeName("Ada");
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });
    await waitFor(() => expect(nameBox()).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    // The new seat is named too — not just the first one.
    expect(allSent(pair).map((m) => m.type)).toEqual([
      "join_public",
      "set_name",
      "leave_room",
      "join_public",
      "set_name",
    ]);
  });

  it("names the seat exactly once per entry (no repeat traffic)", async () => {
    const { harness, player, pair } = await unnamedPlayer();
    typeName("Ada");
    await act(async () => {
      fireEvent.click(quickPlay());
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    // Provoke several roster pushes: a re-render must not re-send.
    // (Quick Play matchmaking puts the guest in the same public room —
    // a public code is deliberately not joinable by code, per Task 17.)
    const guest = harness.addPlayer();
    await connectPlayer(guest);
    await act(async () => {
      guest.client.joinPublicRoom();
    });
    await waitFor(() =>
      expect(screen.queryByTestId("seat-p1")).toBeInTheDocument()
    );
    await act(async () => {
      guest.client.setName("Bob");
    });
    await waitFor(() =>
      expect(screen.getByTestId("seat-p1")).toHaveTextContent("Bob")
    );

    expect(allSent(pair).filter((m) => m.type === "set_name")).toHaveLength(1);
  });
});
