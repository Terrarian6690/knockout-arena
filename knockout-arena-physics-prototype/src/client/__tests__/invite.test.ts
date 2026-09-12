import { describe, expect, it } from "vitest";
import {
  buildInviteUrl,
  copyTextToClipboard,
  getInviteUrl,
  getPrefillJoinCode,
  getRoomCodeQuery,
} from "../components/lobby/invite";

/**
 * Room-invite helpers: pure URL building/parsing plus the total
 * (never-throwing) window-bound wrappers. Browser behavior — the Invite
 * button, the share sheet, clipboard fallbacks, input prefill — is pinned
 * in lobbyInvite.test.tsx; this suite pins the logic headlessly.
 */
describe("room invite helpers", () => {
  it("builds the invite URL from the origin and ?room=CODE", () => {
    expect(buildInviteUrl("https://arena.example", "K7P4")).toBe(
      "https://arena.example/?room=K7P4"
    );
    expect(buildInviteUrl("http://localhost:4173", "X9QA")).toBe(
      "http://localhost:4173/?room=X9QA"
    );
  });

  it("parses ?room=CODE with the Join input's normalization rules", () => {
    expect(getRoomCodeQuery("?room=K7P4")).toBe("K7P4");
    // Lowercase and whitespace are tolerated, exactly like typing.
    expect(getRoomCodeQuery("?room=k7p4")).toBe("K7P4");
    expect(getRoomCodeQuery("?room=k7%20p4")).toBe("K7P4");
    expect(getRoomCodeQuery("?room=%20K7P4%20")).toBe("K7P4");
    // Other params (e.g. ?server=) coexist; the first room param wins.
    expect(getRoomCodeQuery("?server=ws://x&room=X9QA")).toBe("X9QA");
    expect(getRoomCodeQuery("?room=K7P4&room=X9QA")).toBe("K7P4");
  });

  it("rejects invalid ?room= values with null — never throws", () => {
    for (const search of [
      "",
      "?",
      "?room=",
      "?room=%20%20", // whitespace only
      "?room=K7P0", // 0 is excluded from the alphabet
      "?room=K7PI", // I is excluded from the alphabet
      "?room=AB",
      "?room=ABCDE",
      "?room=%21%21%21", // !!!
      "?foo=bar",
    ]) {
      expect(getRoomCodeQuery(search)).toBeNull();
    }
  });

  it("degrades safely outside a browser: empty prefill, no URL, no copy", async () => {
    // This suite runs in the node environment — no window, no document.
    expect(getPrefillJoinCode()).toBe("");
    expect(getInviteUrl("K7P4")).toBeNull();
    expect(await copyTextToClipboard("K7P4")).toBe(false);
  });
});
