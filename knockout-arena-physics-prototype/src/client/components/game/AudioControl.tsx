import { useState } from "react";
import { audio } from "../../audio";

/**
 * The in-match sound control: a compact mute toggle + volume slider in
 * the game header. Native <button>/<input type="range"> elements, so
 * keyboard operability (Tab / Enter / Space / arrows) comes for free.
 * Interactions double as the audio "unlock" gesture (autoplay policy).
 * Settings live in the AudioManager (persisted); React state only
 * mirrors them for the render — no per-sound state churn.
 */
export function AudioControl() {
  const [muted, setMuted] = useState(() => audio.getMuted());
  const [volume, setVolume] = useState(() => audio.getVolume());
  const silent = muted || volume <= 0;

  const toggleMute = () => {
    audio.unlock();
    const next = !muted;
    audio.setMuted(next);
    setMuted(next);
  };

  const changeVolume = (value: number) => {
    audio.unlock();
    audio.setVolume(value);
    setVolume(value);
    if (muted && value > 0) {
      audio.setMuted(false);
      setMuted(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="audio-control">
      <button
        type="button"
        data-testid="audio-toggle"
        aria-label={silent ? "Unmute sound" : "Mute sound"}
        title={silent ? "Unmute sound" : "Mute sound"}
        onClick={toggleMute}
        className="flex h-8 w-8 items-center justify-center rounded-md bg-white/5 text-sm leading-none text-white/60 transition-colors hover:bg-white/10 hover:text-white"
      >
        {silent ? "🔇" : "🔊"}
      </button>
      <input
        type="range"
        data-testid="volume-slider"
        aria-label="Volume"
        title="Volume"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        onChange={(event) => changeVolume(Number(event.target.value) / 100)}
        className="h-1 w-16 cursor-pointer accent-amber-400"
      />
    </div>
  );
}
