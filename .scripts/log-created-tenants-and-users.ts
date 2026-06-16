/**
 * Debug Script
 *
 * Prints all users, tenants and their relation to the console as JSON:
 *   [{ userId, mail, tenants: [{ id, name }] }]
 *
 * Usage:
 *   bun run ./framework/.scripts/debug-tenants-users.ts
 */

import { eq } from "drizzle-orm";
import { createDatabaseClient } from "../src/lib/db/db-connection";
import { users, tenants, tenantMembers } from "../src/lib/db/schema/users";

async function main() {
  const db = createDatabaseClient();

  const rows = await db
    .select({
      userId: users.id,
      mail: users.email,
      tenantId: tenants.id,
      tenantName: tenants.name,
    })
    .from(users)
    .leftJoin(tenantMembers, eq(tenantMembers.userId, users.id))
    .leftJoin(tenants, eq(tenants.id, tenantMembers.tenantId));

  // Group rows by user
  const byUser = new Map<
    string,
    { userId: string; mail: string; tenants: { id: string; name: string }[] }
  >();

  for (const row of rows) {
    let entry = byUser.get(row.userId);
    if (!entry) {
      entry = { userId: row.userId, mail: row.mail, tenants: [] };
      byUser.set(row.userId, entry);
    }
    if (row.tenantId && row.tenantName) {
      entry.tenants.push({ id: row.tenantId, name: row.tenantName });
    }
  }

  const result = Array.from(byUser.values());
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
