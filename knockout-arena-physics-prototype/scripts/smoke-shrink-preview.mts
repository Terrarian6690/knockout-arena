/**
 * TASK 30 SMOKE TEST — the shrink preview across a REAL match.
 *
 * Two clients connect to the production server stack over a real
 * WebSocket, play full rounds until the arena has shrunk all the way to
 * its minimum, and at every round the snapshot each client receives is
 * fed to the REAL renderer through a recording 2D context.
 *
 * What it proves, per round, from actual draw calls:
 *   - no boundary ring is stroked at the arena edge (the white ring is
 *     gone for good, not merely recoloured);
 *   - a red dashed ring appears in exactly the round before each shrink,
 *     at the next radius, and in no other round;
 *   - it is gone the moment the shrink lands;
 *   - it never appears once the arena is at its minimum radius.
 *
 * Run against a server started from the BUILT artifact.
 */
import { WebSocket } from "ws";
import {
  CONFIG,
  arenaEdgeRadius,
  arenaFromSnapshot,
  createArena,
  type GameStateSnapshot,
} from "../src/game/index.js";
import { render } from "../src/client/renderer.js";

const PORT = Number(process.env.SMOKE_PORT ?? 4199);
const URL = `ws://127.0.0.1:${PORT}`;
const PROTOCOL_VERSION = 1;
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const RED = CONFIG.colors.outOfBounds;

interface Call {
  op: string;
  args: unknown[];
}

function recordingCtx() {
  const calls: Call[] = [];
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {
    canvas: { width: 900, height: 700 },
    createRadialGradient: () => gradient,
  };
  for (const op of [
    "save", "restore", "clearRect", "fillRect", "translate", "scale",
    "beginPath", "closePath", "arc", "fill", "stroke", "setLineDash",
    "moveTo", "lineTo",
  ]) {
    target[op] = (...args: unknown[]) => calls.push({ op, args });
  }
  const props = new Map<string, unknown>();
  const ctx = new Proxy(target, {
    get: (t, p: string) => (p in t ? t[p] : props.get(p)),
    set: (_t, p: string, v) => {
      props.set(p, v);
      calls.push({ op: `set:${p}`, args: [v] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Radii of red dashed strokes — the preview rings actually painted. */
function redDashedRings(calls: Call[]): number[] {
  const out: number[] = [];
  let arc: [number, number, number] | null = null;
  let color: unknown = null;
  let dashed = false;
  for (const c of calls) {
    if (c.op === "arc") arc = c.args as [number, number, number];
    else if (c.op === "set:strokeStyle") color = c.args[0];
    else if (c.op === "setLineDash") {
      const p = c.args[0] as number[];
      dashed = Array.isArray(p) && p.length > 0;
    } else if (c.op === "stroke" && arc && color === RED && dashed) out.push(arc[2]);
  }
  return out;
}

/** Any stroke in the old boundary-ring colours? */
function boundaryRingStrokes(calls: Call[]): string[] {
  return calls
    .filter((c) => c.op === "set:strokeStyle")
    .map((c) => String(c.args[0]))
    .filter((c) => c === CONFIG.colors.arenaWallGlow || c.includes("126,168,209"));
}

function drawFor(snapshot: GameStateSnapshot) {
  const { ctx, calls } = recordingCtx();
  render(ctx, snapshot, arenaFromSnapshot(snapshot), {
    scale: 1, offsetX: 0, offsetY: 0,
  });
  return calls;
}

// ── A tiny client ────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket;
  playerId: string;
  snapshot: GameStateSnapshot | null;
  roomId: string | null;
  /**
   * Every distinct aiming round this client saw, keyed by the
   * authoritative roundNumber. Captured in the socket handler rather
   * than by polling: two rounds can resolve between polls, and an
   * unsampled round is exactly where a missing preview would hide.
   */
  rounds: Map<number, GameStateSnapshot>;
}

function send(c: Client, msg: Record<string, unknown>) {
  c.ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...msg }));
}

function connect(name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const client: Client = {
      ws, playerId: "", snapshot: null, roomId: null, rounds: new Map(),
    };
    const timer = setTimeout(() => reject(new Error(`${name}: connect timeout`)), 10_000);
    // `welcome` is a REPLY to create_room/join_room, not a greeting on
    // connect — resolve as soon as the socket is open.
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg.type === "welcome") {
        client.playerId = String(msg.playerId);
        client.roomId = msg.roomId ? String(msg.roomId) : null;
      } else if (msg.type === "snapshot") {
        // The wire field is `state` (see protocol.snapshotMessage).
        const view = msg.state as GameStateSnapshot & { roundNumber?: number };
        client.snapshot = view;
        if (view.phase === "aiming" && typeof view.roundNumber === "number") {
          if (!client.rounds.has(view.roundNumber)) {
            client.rounds.set(view.roundNumber, view);
          }
        }
      } else if (msg.type === "room_state") {
        client.roomId = msg.room ? String((msg.room as Record<string, unknown>).roomId) : client.roomId;
      }
    });
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, ms = 15_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// ── The run ──────────────────────────────────────────────────────────────

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log(`\nTask 30 shrink-preview smoke — ${URL}\n`);

  const host = await connect("host");
  send(host, { type: "create_room" });
  await waitFor(() => host.roomId !== null, "room created");
  const roomId = host.roomId!;

  const guest = await connect("guest");
  send(guest, { type: "join_room", roomId });
  await waitFor(() => guest.roomId === roomId, "guest joined");

  send(host, { type: "start_match" });
  await waitFor(
    () => host.snapshot !== null && guest.snapshot !== null,
    "first snapshot"
  );
  console.log(`room ${roomId}: match started\n`);

  let guard = 0;
  let roundsAtMin = 0;

  // ── Play ───────────────────────────────────────────────────────────────
  // Drive rounds until the arena has been at its minimum for a while.
  // Verification happens afterwards, over EVERY round captured in the
  // socket handler — so a round that slipped past between polls is still
  // audited.
  while (guard < 40 && roundsAtMin < 4) {
    guard += 1;
    await waitFor(
      () => host.snapshot?.phase === "aiming",
      `aiming phase (round ${guard})`
    );
    if (host.snapshot?.arena?.atMinRadius) roundsAtMin += 1;

    // Both players aim inward at low power, so nobody is eliminated and
    // the match survives long enough to walk the whole schedule.
    for (const c of [host, guest]) {
      send(c, { type: "command", command: { type: "aim", x: CX, y: CY } });
      send(c, { type: "command", command: { type: "setPower", power: 1 } });
      send(c, { type: "command", command: { type: "confirmLaunch" } });
    }
    await waitFor(
      () => host.snapshot?.phase !== "aiming",
      `round ${guard} resolving`,
      20_000
    ).catch(() => {});
    await sleep(120);
    if (host.snapshot?.phase === "finished") {
      console.log(`(match ended after round ${guard})\n`);
      break;
    }
  }

  // ── Verify every captured round ────────────────────────────────────────
  const rounds = [...host.rounds.entries()].sort((a, b) => a[0] - b[0]);
  check(rounds.length > 0, "captured at least one round");

  const transitions: string[] = [];
  let previous: GameStateSnapshot | null = null;
  const seenRadii: number[] = [];

  for (const [roundNumber, snap] of rounds) {
    const arena = snap.arena;
    if (!arena) {
      check(false, `round ${roundNumber}: snapshot carries an arena projection`);
      continue;
    }
    if (seenRadii[seenRadii.length - 1] !== arena.radius) {
      seenRadii.push(arena.radius);
    }

    const calls = drawFor(snap);
    const rings = redDashedRings(calls);
    const guestSnap = guest.rounds.get(roundNumber);

    // The old white ring must never reappear, in any round.
    check(
      boundaryRingStrokes(calls).length === 0,
      `round ${roundNumber} (r=${arena.radius}): no boundary ring stroked`
    );

    // Both clients must paint the same preview.
    if (guestSnap) {
      const guestRings = redDashedRings(drawFor(guestSnap));
      check(
        JSON.stringify(rings) === JSON.stringify(guestRings),
        `round ${roundNumber}: host and guest agree`
      );
    }

    if (arena.shrinkWarning) {
      const expected = arenaEdgeRadius(createArena(arena.nextRadius!));
      const ok = rings.length === 1 && rings[0] === expected;
      check(
        ok,
        `round ${roundNumber} (r=${arena.radius}): red dashed preview at ${arena.nextRadius}`
      );
      transitions.push(`${arena.radius}→${arena.nextRadius}`);
    } else {
      check(
        rings.length === 0,
        `round ${roundNumber} (r=${arena.radius}): no preview (shrink not imminent)`
      );
    }

    if (arena.atMinRadius) {
      check(
        rings.length === 0 && arena.nextRadius === null,
        `round ${roundNumber}: at MIN radius — no preview, ever`
      );
    }

    // A preview in round N must be the radius actually adopted later.
    if (previous?.arena?.shrinkWarning && previous.arena.nextRadius !== null) {
      check(
        arena.radius === previous.arena.nextRadius,
        `round ${roundNumber}: previewed ${previous.arena.nextRadius} became the real radius`
      );
      check(
        rings.length === 0,
        `round ${roundNumber}: no leftover preview after the shrink landed`
      );
    }
    previous = snap;
  }

  console.log(`\nrounds captured: ${rounds.length}`);
  console.log(`radii seen: ${seenRadii.join(" → ")}`);
  console.log(`previewed transitions: ${transitions.join(", ") || "none"}`);

  // All four shrink transitions must have been previewed.
  for (const expected of ["330→290", "290→250", "250→210", "210→180"]) {
    check(transitions.includes(expected), `previewed the ${expected} shrink`);
  }

  send(host, { type: "leave_room" });
  send(guest, { type: "leave_room" });
  await sleep(150);
  host.ws.close();
  guest.ws.close();

  console.log(failures === 0 ? "\nSMOKE PASSED\n" : `\nSMOKE FAILED (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke error:", err);
  process.exit(1);
});
