import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// One connection pool per process. Next's dev server re-evaluates modules on
// change, so the client is cached on globalThis to avoid exhausting connections.
const globalForDb = globalThis as unknown as {
  __misePg?: ReturnType<typeof postgres>;
};

const sql = globalForDb.__misePg ?? postgres(connectionString, { max: 5 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__misePg = sql;
}

export const db = drizzle(sql, { schema });
export type Db = typeof db;
