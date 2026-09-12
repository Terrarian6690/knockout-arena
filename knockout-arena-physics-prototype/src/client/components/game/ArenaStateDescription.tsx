import { useMemo } from "react";
import type { GameStateSnapshot } from "../../../game";
import { describeArenaState, descriptionKey } from "./arenaDescription";

/**
 * The canvas's text alternative (Task 12, first pass).
 *
 * A visually hidden element holding a plain-language summary of the
 * public board state, associated with the canvas through
 * `aria-describedby`. A screen reader user who lands on the arena hears
 * what is on it; everyone else sees nothing change.
 *
 * WHY NOT A LIVE REGION. This carries no `role="status"` and no
 * `aria-live`, on purpose. It is a DESCRIPTION of current state, read
 * when the user asks for it, not an EVENT worth interrupting for. The
 * event-driven announcements already exist and stay untouched: the
 * match result (Task 9) and eliminations / round transitions (Task 10).
 * Making this polite as well would mean every elimination was spoken
 * twice — once as news, once as a re-read of the whole roster.
 *
 * WHY THE TEXT IS MEMOISED. Snapshots arrive continuously: pawns slide,
 * aim previews update, deadlines tick. None of that changes a word
 * here, so the text is rebuilt only when the public state it describes
 * actually differs (see descriptionKey). The DOM node is left alone
 * through every other push, which also means assistive technology
 * reading it cannot be disturbed mid-sentence.
 */
interface ArenaStateDescriptionProps {
  /** The latest authoritative snapshot, or null before the first one. */
  readonly snapshot: GameStateSnapshot | null;
  /** Seat id of the room host, as reported by the server. */
  readonly hostPlayerId: string | null;
  /** DOM id the canvas points at with aria-describedby. */
  readonly id: string;
}

export function ArenaStateDescription({
  snapshot,
  hostPlayerId,
  id,
}: ArenaStateDescriptionProps) {
  // Keyed on the described state, not the snapshot object: identical
  // public state re-renders produce the identical string and React
  // leaves the text node untouched.
  const key = descriptionKey({ snapshot, hostPlayerId });
  const text = useMemo(
    () => describeArenaState({ snapshot, hostPlayerId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  return (
    <div id={id} data-testid="arena-state-description" className="sr-only">
      {text}
    </div>
  );
}
