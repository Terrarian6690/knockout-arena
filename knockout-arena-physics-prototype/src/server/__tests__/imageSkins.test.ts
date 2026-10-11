import { afterEach, describe, expect, it } from "vitest";
import {
  IMAGE_SKIN_BASE,
  choosableImageSkins,
  imageSkinById,
  secretSkinForName,
  IMAGE_SKINS,
} from "../../game";
import {
  createGameServer,
  type GameServer,
} from "../index";

/**
 * The IMAGE-BASED disc skins: the choosable one rides the wardrobe like
 * any palette skin; the SECRET ones are awarded by the SERVER to seats
 * whose display name contains the trigger (case-insensitive substring,
 * list order = priority) and are never settable, never listed.
 *
 * The lifecycle contract:
 *   - setName evaluates the trigger: matching name → the seat wears the
 *     secret skin; renaming away gives the explicit pick back (or a
 *     fresh random deal when there was none);
 *   - set_skin accepts the CHOOSABLE image id and refuses the secret
 *     ones with the ordinary "invalid-skin" (no existence leak);
 *   - the random deal NEVER deals an image skin (palette only);
 *   - a freed seat loses the secret with its name (the seat resets).
 */

const liveServers: GameServer[] = [];

afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function newServer(): GameServer {
  // Deterministic deals: always the FIRST still-available palette
  // index — so "a random deal happened" is directly observable (0, 1, …).
  const server = createGameServer({ randomSkinIndex: () => 0 });
  liveServers.push(server);
  return server;
}

function must<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function seatSkins(server: GameServer, roomCode: string): number[] {
  const room = server.getRoom(roomCode);
  if (!room) throw new Error(`room ${roomCode} gone`);
  return room.seats.map((s) => s.skin);
}

/** A seated host (p0) in a fresh room. */
function seatedHost() {
  const server = newServer();
  const host = server.connect();
  const created = must(server.createRoom(host));
  return { server, host, room: created.room };
}

const [publicSkin] = choosableImageSkins();
const SECRET_IDS = IMAGE_SKINS.filter((d) => d.trigger !== null).map((d) => d.id);

describe("image-skin data contract", () => {
  it("secret ids sit at 100+ and every skin has a unique id", () => {
    const ids = IMAGE_SKINS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(IMAGE_SKIN_BASE);
    expect(publicSkin!.trigger).toBeNull();
    expect(SECRET_IDS.length).toBe(3);
  });

  it("the trigger match is a case-insensitive substring, list order wins", () => {
    expect(secretSkinForName("LOLmaster")).toBe(101);
    expect(secretSkinForName("stone the SIGM")).toBe(102);
    expect(secretSkinForName("just TYRU fan")).toBe(103);
    expect(secretSkinForName("plain player")).toBeNull();
    // Two triggers in one name: the EARLIER skin in list order wins.
    expect(secretSkinForName("sigm lol")).toBe(101);
    expect(imageSkinById(101)!.trigger).toBe("lol");
  });
});

describe("set_skin with image skins", () => {
  it("accepts the CHOOSABLE image skin like a palette index", () => {
    const { server, host, room } = seatedHost();
    must(server.setSkin(host, publicSkin!.id));
    expect(seatSkins(server, room.code)[0]).toBe(publicSkin!.id);
  });

  it("refuses the SECRET skins with the ordinary invalid-skin (no leak)", () => {
    const { server, host } = seatedHost();
    for (const id of SECRET_IDS) {
      const result = server.setSkin(host, id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-skin");
    }
  });
});

describe("the secret name-trigger assignment", () => {
  it("a matching name wears the secret skin (assigned by the server alone)", () => {
    const { server, host, room } = seatedHost();
    must(server.setName(host, "lolmaster"));
    expect(seatSkins(server, room.code)[0]).toBe(101);
  });

  it("renaming away hands the EXPLICIT pick back; renaming back re-awards", () => {
    const { server, host, room } = seatedHost();
    // Explicit palette choice first…
    must(server.setSkin(host, 3));
    // …then the name earns the secret over it.
    must(server.setName(host, "lolguy"));
    expect(seatSkins(server, room.code)[0]).toBe(101);
    // Rename away: the explicit choice comes back…
    must(server.setName(host, "guty"));
    expect(seatSkins(server, room.code)[0]).toBe(3);
    // …and the trigger re-applies on the way back.
    must(server.setName(host, "lil LOL"));
    expect(seatSkins(server, room.code)[0]).toBe(101);
  });

  it("renaming away without an explicit pick falls back to a fresh random deal", () => {
    const { server, host, room } = seatedHost();
    must(server.setName(host, "lolguy")); // secret (the deal was 0)
    expect(seatSkins(server, room.code)[0]).toBe(101);
    must(server.setName(host, "guty"));
    expect(seatSkins(server, room.code)[0]).toBe(0); // the deterministic deal
  });

  it("a matching name re-awards the secret after the Random reset too", () => {
    const { server, host, room } = seatedHost();
    must(server.setName(host, "sigmstone"));
    expect(seatSkins(server, room.code)[0]).toBe(102);
    must(server.setSkin(host, 4)); // conscious pick wins for now
    expect(seatSkins(server, room.code)[0]).toBe(4);
    must(server.setSkin(host, null)); // Random: re-deal, then re-evaluate
    expect(seatSkins(server, room.code)[0]).toBe(102);
  });

  it("a freed seat keeps nothing: no secret, no explicit pick", () => {
    const { server, host, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code)); // deal 1; keeps the room alive
    must(server.setName(guest, "lolguy"));
    must(server.setSkin(guest, publicSkin!.id)); // explicit image pick
    must(server.setName(guest, "guty")); // explicit restored
    // The seat frees when its player leaves…
    must(server.leaveRoom(guest));
    // …a new occupant gets a clean deterministic deal (first available
    // beside p0's 0 → 1), not the explicit pick, not the secret.
    const next = server.connect();
    const joined = must(server.joinRoom(next, room.code));
    expect(joined.room.seats[1].skin).toBe(1);
    void host;
  });
});
