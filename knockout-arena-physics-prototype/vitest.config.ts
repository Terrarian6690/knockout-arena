import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Standalone test config (does NOT load vite.config.ts, so the React /
// Tailwind / singlefile plugins stay out of the engine test run).
//
// environment: "node" is deliberate — the engine in src/game/ (everything
// except useGame.ts) must remain DOM-free/headless so the same code can later
// run in a server-authoritative simulation. If a test needs a DOM, it belongs
// in a UI-level suite, not here.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
