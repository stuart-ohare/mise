import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// Unit tests only: pure domain functions, no database, no network, no API calls.
// Database tests (*.db.test.ts) run under vitest.db.config.mts via `pnpm test:db`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    // `app/**` is included so a route's offline test actually runs: gate-fixtures.sh
    // matches *.test.ts anywhere, so a gate-tagged test left out of this list would
    // satisfy §4.2 while executing nothing.
    include: [
      "app/**/*.test.ts",
      "lib/**/*.test.ts",
      "scripts/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
  },
});
