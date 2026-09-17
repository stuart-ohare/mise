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
    // Next substitutes `server-only` at compile time and never resolves the npm package,
    // so Vitest has to do the same to load a module that carries the marker. This is the
    // empty module Next's own client compiler swaps in. It costs nothing: the marker's
    // job is to fail a client bundle, and Vitest is Node.
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
