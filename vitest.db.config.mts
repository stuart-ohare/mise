import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: ".env.local" });

// Database tests only: needs `docker compose up -d` and `pnpm db:push`. Every test
// writes inside a transaction that rolls back, so the database is left as found.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // Same `server-only` substitution as vitest.config.mts — see the note there.
      "server-only": "next/dist/compiled/server-only/empty",
    },
  },
  test: {
    environment: "node",
    include: ["**/*.db.test.ts"],
    exclude: ["node_modules/**"],
    fileParallelism: false,
  },
});
