/**
 * Admin Script
 *
 * Lists all users and tenants (numbered), then asks interactively which user
 * should become "owner" of which tenant.
 *
 * Usage:
 *   bun run ./framework/.scripts/make-user-owner-of-all-tenants.ts
 */

import { and, eq } from "drizzle-orm";
import { createDatabaseClient } from "../src/lib/db/db-connection";
import { users, tenants, tenantMembers } from "../src/lib/db/schema/users";

function ask(question: string): number {
  const answer = prompt(question);
  const index = Number.parseInt((answer ?? "").trim(), 10);
  if (Number.isNaN(index)) {
    console.error("Invalid input. Please enter a number.");
    process.exit(1);
  }
  return index;
}

async function main() {
  const db = createDatabaseClient();

  // 1. List all users
  const allUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .orderBy(users.email);

  if (allUsers.length === 0) {
    console.log("No users found.");
    return;
  }

  console.log("\n=== Users ===");
  allUsers.forEach((u, i) => console.log(`  [${i}] ${u.email} (${u.id})`));

  // 2. List all tenants
  const allTenants = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .orderBy(tenants.name);

  if (allTenants.length === 0) {
    console.log("No tenants found.");
    return;
  }

  console.log("\n=== Tenants ===");
  allTenants.forEach((t, i) => console.log(`  [${i}] ${t.name} (${t.id})`));

  // 3. Ask which user and which tenant
  console.log("");
  const userIndex = ask("Which user? (enter number) ");
  const tenantIndex = ask("Which tenant? (enter number) ");

  const user = allUsers[userIndex];
  const tenant = allTenants[tenantIndex];

  if (!user) {
    console.error(`No user at index ${userIndex}.`);
    process.exit(1);
  }
  if (!tenant) {
    console.error(`No tenant at index ${tenantIndex}.`);
    process.exit(1);
  }

  // 4. Make the user owner of the selected tenant (insert or update membership)
  await db
    .insert(tenantMembers)
    .values({ userId: user.id, tenantId: tenant.id, role: "owner" })
    .onConflictDoUpdate({
      target: [tenantMembers.userId, tenantMembers.tenantId],
      set: { role: "owner" },
    });

  // Read back to confirm
  const result = await db
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.userId, user.id),
        eq(tenantMembers.tenantId, tenant.id)
      )
    )
    .limit(1);

  console.log(
    `\nDone: ${user.email} is now "${result[0]?.role}" of tenant "${tenant.name}".`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
