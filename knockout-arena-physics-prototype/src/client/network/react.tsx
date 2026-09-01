import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createNetworkClient,
  type NetworkClient,
  type NetworkClientOptions,
} from "./websocketClient";
import type { NetworkClientState } from "./types";

/**
 * React glue for the network client — the ONLY place where the networking
 * core meets React.
 *
 * The client itself is framework-free and exposes the external-store
 * contract (getState + subscribe), so this file contains no state of its
 * own: the provider owns exactly ONE client per mount, and the hooks are
 * thin wrappers around useSyncExternalStore. No WebSocket ever lives
 * inside a component; components read state and call actions.
 */

const NetworkClientContext = createContext<NetworkClient | null>(null);

export interface NetworkProviderProps {
  children: ReactNode;
  /**
   * Inject an already-built client (used by tests, which then own its
   * lifecycle — the provider will neither connect nor close it).
   */
  client?: NetworkClient;
  /**
   * Options for the internally created client. Read on first render only:
   * one provider mount owns exactly one client for its whole lifetime.
   */
  createOptions?: NetworkClientOptions;
}

/**
 * Provides exactly one network client to the subtree. When no client is
 * injected, the provider creates one, connects it on mount and closes it
 * on unmount. (React StrictMode's double-invoked effects are safe: each
 * effect run creates and later closes its own client.)
 */
export function NetworkProvider({
  children,
  client: injectedClient,
  createOptions,
}: NetworkProviderProps) {
  const [client, setClient] = useState<NetworkClient | null>(
    injectedClient ?? null
  );

  useEffect(() => {
    if (injectedClient) return; // the caller owns this client's lifecycle
    const created = createNetworkClient(createOptions);
    created.connect();
    setClient(created);
    return () => created.close();
    // Deliberately mount-only: the provider owns one client per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (client === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0e14] text-white/50">
        Connecting…
      </div>
    );
  }

  return (
    <NetworkClientContext.Provider value={client}>
      {children}
    </NetworkClientContext.Provider>
  );
}

/** The network client (for actions: connect, createRoom, submitCommand…). */
export function useNetworkClient(): NetworkClient {
  const client = useContext(NetworkClientContext);
  if (client === null) {
    throw new Error("useNetworkClient must be used within <NetworkProvider>");
  }
  return client;
}

/**
 * The network client's state, subscribed through React's external-store
 * contract. Referentially stable between server pushes.
 */
export function useNetworkState(): NetworkClientState {
  const client = useNetworkClient();
  return useSyncExternalStore(client.subscribe, client.getState);
}

/**
 * The default server URL: same origin as the page (ws/wss following the
 * page protocol), overridable — e.g. `?server=ws://localhost:8080` for
 * local development against a standalone game server.
 */
export function defaultServerUrl(override?: string | null): string {
  if (typeof override === "string" && override.length > 0) return override;
  if (typeof window === "undefined") return "ws://localhost:8080";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}
