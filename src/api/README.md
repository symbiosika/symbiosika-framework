# Framework Public API (`@framework/*` subpath exports)

This folder defines the **curated, supported surface** of the framework — the
"allowed" set of things app code may import.

Each file here is a thin barrel that re-exports a focused slice of the framework
under a stable subpath. App code should import **only** from these subpaths, not
by reaching into `lib/...` or `routes/...` directly. That keeps the surface
explicit, refactor-safe (internals can move without touching consumers), and
documentable.

## Subpaths

| Import | Contains |
| --- | --- |
| `@framework/server` | `defineServer`, `GLOBAL_SERVER_CONFIG`, `log`, `smtpService`, and the core types `SymbiosikaFrameworkHonoApp`, `SFContextVariables`, `ServerSpecificConfig` |
| `@framework/db` | `getDb`, `waitForDbConnection`, `createDatabaseClient`, `getDbSchema`, `getValidDbSchemaTableNames`, `initializeFullDbSchema`, `DatabaseSchema` |
| `@framework/schema` | All framework `base_*` tables and their drizzle-valibot schemas (`users`, `tenants`, `tenantMembers`, `connections`, `files`, `knowledgeGroup`, `knowledgeEntry`, …) |
| `@framework/auth` | `saltAndHashPassword`, `generateJwt`, `generateUserSessionJwt`, `createJwtSessionForUserId`, `checkGeneralInvitationCode`, `LocalAuth` |
| `@framework/middlewares` | `authAndSetUsersInfo`, `authOrRedirectToLogin`, `authAndSetUsersInfoOrRedirectToLogin`, `checkUserPermission`, `checkToken`, `addScopesToContext`, `validateScope`, `isTenantMember`, `isTenantAdmin`, `checkTenantIdInBody`, `HTTPException` |
| `@framework/tenants` | `createTenant`, `getTenant`, `deleteTenant`, `addTenantMember`, `getTenantMembers`, `getTenantMemberRole`, `setUsersLastTenant` |
| `@framework/connections` | `connectionsService`, `getConnection`, `getConnectionByTenantAndName`, `getConnectionByRemoteConnectionId`, `getConnectionByLocalTenant`, `verifySignature`, `signData`, `generateKeyPair`, `authenticateConnection` |
| `@framework/crypt` | `getSecret`, `setSecret`, `deleteSecret`, `getSecrets`, `isValidSecretName` |
| `@framework/knowledge` | `getNearestEmbeddings`, `getFullSourceDocumentsForSimilaritySearch`, `createKnowledgeGroup` |
| `@framework/testing` | **Test-only.** `initTests`, `testFetcher`, and the `TEST_*` fixtures + org/user/member setup helpers |

## Resolution

Consumers map these subpaths in their `tsconfig.json` `paths`:

```jsonc
"paths": {
  "@framework/server":      ["./framework/src/api/server.ts"],
  "@framework/db":          ["./framework/src/api/db.ts"],
  "@framework/schema":      ["./framework/src/api/schema.ts"],
  "@framework/auth":        ["./framework/src/api/auth.ts"],
  "@framework/middlewares": ["./framework/src/api/middlewares.ts"],
  "@framework/tenants":     ["./framework/src/api/tenants.ts"],
  "@framework/connections": ["./framework/src/api/connections.ts"],
  "@framework/crypt":       ["./framework/src/api/crypt.ts"],
  "@framework/knowledge":   ["./framework/src/api/knowledge.ts"],
  "@framework/testing":     ["./framework/src/api/testing.ts"],
  "@framework/*":           ["./framework/src/*"] // legacy deep paths — avoid in new code
}
```

The explicit subpaths take precedence over the `@framework/*` wildcard, which is
kept only for backwards compatibility. **New code should not use the wildcard.**

## Adding to the API

Need something not exposed yet? Add a named re-export to the matching barrel (or
create a new barrel + tsconfig entry in every consumer). Prefer named re-exports
over `export *` so the surface stays intentional — `schema.ts` and `testing.ts`
are the deliberate exceptions, where exposing the full set is the whole purpose.
