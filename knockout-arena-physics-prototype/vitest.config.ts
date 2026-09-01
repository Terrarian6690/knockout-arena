import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Standalone test config (does NOT load vite.config.ts, so the React /
// Tailwind / singlefile plugins stay out of the test run).
//
// environment: "node" is deliberate — the engine package in src/game must
// remain DOM-free/headless so the same code can later run in a server-
// authoritative simulation (enforced by src/game/__tests__/dom-free.test.ts).
// The client-boundary test in src/client also only reads files, so it runs
// headlessly too. If a test needs a DOM, it belongs in a UI-level suite
// with its own environment, not here — which is exactly what the lobby
// component tests do: they are .test.tsx files that opt into jsdom via a
// `// @vitest-environment jsdom` docblock, leaving every other suite in
// the headless node environment.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
