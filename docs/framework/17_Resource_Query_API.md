# Resource Query API (Generic Table API via URL)

The resource system turns a single Drizzle table definition into a complete,
tenant-scoped CRUD resource: business logic, Hono routes and (optionally) AI
tools. The list endpoint exposes a **normalized, URL-driven query API** for
filtering, searching, sorting, pagination and relation expansion — similar to
the table APIs offered by PostgREST / Supabase / Directus.

## Defining a resource

```typescript
import { defineResource } from "@framework/lib/resource";
import { competitors, competitorsInsertSchema, competitorsUpdateSchema } from "../db/schema";
import { desc, asc } from "drizzle-orm";

export const competitorsResource = defineResource({
  table: competitors,
  name: "competitors",
  route: "/tenant/:tenantId/competitors",
  insertSchema: competitorsInsertSchema,
  updateSchema: competitorsUpdateSchema,
  defaultOrderBy: (t) => [desc(t.createdAt)],
  // optional: enable ?expand=
  relations: {
    queryKey: "competitors",        // key under db.query.*
    allowed: ["tenant", "owner"],   // relations callers may expand
  },
});

// In your route setup:
competitorsResource.registerRoutes(app);
```

The table **must** have `id` and `tenantId` columns. Every query is implicitly
scoped to the `tenantId` from the URL.

## Generated endpoints

| Method | Path            | Purpose                                  |
| ------ | --------------- | ---------------------------------------- |
| GET    | `/`             | List with filtering / sorting / paging   |
| GET    | `/:id`          | Get one                                  |
| POST   | `/`             | Create                                   |
| PUT    | `/:id`          | Update                                   |
| DELETE | `/:id`          | Delete                                   |
| GET    | `/markdown`     | Markdown export (only if configured)     |

## Query syntax (GET `/`)

Filtering uses a PostgREST-style `operator.value` form. Any query parameter
that is **not** a reserved key is treated as a filter on the column of that
name. Unknown columns are silently ignored (validated against the real table
columns), so filters can never reach arbitrary fields.

```text
GET /tenant/:tenantId/competitors
      ?status=eq.active        →  status = 'active'
      &name=like.john          →  name ILIKE '%john%'
      &score=gte.5             →  score >= 5
      &score=lte.10            →  score <= 10
      &id=in.(1,2,3)           →  id IN ('1','2','3')
      &country=DE              →  country = 'DE'   (no prefix ⇒ eq)
```

Supported operators: `eq`, `like` (case-insensitive contains), `gte`, `lte`,
`in`.

### Reserved keys

| Param            | Meaning                                            |
| ---------------- | -------------------------------------------------- |
| `limit`          | Max rows (positive integer)                        |
| `offset`         | Rows to skip (>= 0)                                |
| `orderBy`        | Column name to sort by                             |
| `orderDirection` | `asc` (default) or `desc`                          |
| `expand`         | Comma-separated relation names to eager-load       |

If the prefix before the first `.` is not a known operator, the entire value is
treated as an `eq` match (e.g. `?domain=example.com` filters for the literal
`example.com`).

## Relations (`expand`)

When `relations` is configured, callers can eager-load related rows:

```text
GET /tenant/:tenantId/competitors?expand=tenant,owner&limit=20
```

Expansion uses Drizzle's relational query API
(`db.query.<queryKey>.findMany({ with })`), so the table's `relations()` must be
registered in the schema. `relations.allowed` acts as an allow-list — any
relation not listed there is ignored.

**Limitation:** filters and ordering apply to the **root table only**. Relations
are eager-loaded but cannot themselves be filtered through the URL — this is a
deliberate constraint of Drizzle's relational query builder. If you need to
filter a parent by a child's column, write a dedicated endpoint with an explicit
join.

## Programmatic access

The same options are available directly on `resource.operations.getAll`:

```typescript
const rows = await competitorsResource.operations.getAll(tenantId, {
  filters: [{ field: "status", operator: "eq", value: "active" }],
  orderBy: "createdAt",
  orderDirection: "desc",
  limit: 20,
  expand: ["tenant"],
});
```

The URL parser is exported as well, so the same syntax can be reused elsewhere:

```typescript
import { parseQueryOptions } from "@framework/lib/resource";

const options = parseQueryOptions(c.req.query());
```
