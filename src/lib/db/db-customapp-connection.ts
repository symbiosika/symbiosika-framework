import pg from "pg";

const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const POSTGRE_CA_CERT = process.env.POSTGRE_CA_CERT ?? "";
const POSTGRES_USE_SSL = !process.env.POSTGRES_USE_SSL
  ? true
  : process.env.POSTGRES_USE_SSL !== "false";

console.log("POSTGRES_USE_SSL is", POSTGRES_USE_SSL);

const createPool = () => {
  return new pg.Pool({
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    database: POSTGRES_DB,
    max: 3,
    idleTimeoutMillis: 60000,
    ...(POSTGRES_USE_SSL && {
      ssl: {
        rejectUnauthorized: false,
        ca: POSTGRE_CA_CERT,
      },
    }),
    ...(POSTGRES_USE_SSL === false && {
      ssl: false,
    }),
  });
};

const setupPoolListeners = (pool: pg.Pool) => {
  pool.on("connect", () => console.log("PG Pool connected to the database"));
  pool.on("error", (err) => console.error("PG Pool Error ", err));
};

const setupClientListeners = (client: pg.PoolClient) => {
  client.on("error", async (err) => {
    console.error("PG Client error:", err.stack);
    client.release();
    await createCustomAppDatabaseClient();
  });

  client.on("end", async () => {
    console.error("PG Client ended the connection.");
    await createCustomAppDatabaseClient();
  });

  client.on("notification", (msg) =>
    console.log("PG Client notification:", msg)
  );
  client.on("notice", (msg) => console.log("PG Client notice:", msg));
};

export const createCustomAppDatabaseClient = async () => {
  const pool = createPool();
  setupPoolListeners(pool);

  const client = await pool.connect();
  setupClientListeners(client);

  return client;
};
