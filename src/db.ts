import pg from "pg";
const { Pool } = pg;
export type { Pool, PoolClient } from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

export async function withTransaction<T>(
  poolOrClient: pg.Pool | pg.PoolClient,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const isClient =
    "release" in poolOrClient &&
    typeof (poolOrClient as pg.PoolClient).query === "function" &&
    !("totalCount" in poolOrClient);

  const client = isClient
    ? (poolOrClient as pg.PoolClient)
    : await (poolOrClient as pg.Pool).connect();
  const shouldRelease = !isClient;

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}
