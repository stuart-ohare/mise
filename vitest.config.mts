import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests only: pure domain functions, no database, no network, no API calls.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
