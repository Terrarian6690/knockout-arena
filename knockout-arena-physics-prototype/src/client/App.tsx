import { useState } from "react";
import { Lobby } from "./components/lobby/Lobby";
import { NetworkProvider, defaultServerUrl } from "./network/react";
import { SoloGame } from "./SoloGame";

/**
 * Knockout Arena app shell.
 *
 * The app has two modes:
 *   - lobby (default): the multiplayer lobby over the network client —
 *     create/join a room, see the server-reported roster, start a match;
 *   - solo: the original single-player prototype (unchanged, local engine).
 *
 * The lobby is the entry point of the multiplayer era; solo practice stays
 * one click away. The game server URL defaults to the page's own origin
 * and can be overridden with `?server=ws://host:port`.
 */
type AppMode = "lobby" | "solo";

export default function App() {
  const [mode, setMode] = useState<AppMode>("lobby");
  const [serverUrl] = useState(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("server")
  );

  if (mode === "solo") {
    return <SoloGame onExit={() => setMode("lobby")} />;
  }

  return (
    <NetworkProvider createOptions={{ url: defaultServerUrl(serverUrl) }}>
      <Lobby onPracticeSolo={() => setMode("solo")} />
    </NetworkProvider>
  );
}
