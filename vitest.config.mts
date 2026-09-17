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
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
  },
});
