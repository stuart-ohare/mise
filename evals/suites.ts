import type { AnySuite } from "./harness";

/** Every suite `pnpm eval` runs. Empty until the first suite lands (#32). */
export const suites: readonly AnySuite[] = [];
