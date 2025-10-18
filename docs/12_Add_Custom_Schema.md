# Adding Custom Database Schema

The fastapp-framework provides many built-in database tables (see [Built-in DB Schema](./11_BuildIn_DB_Schema.md)), but your application can also define custom tables with its own prefix.

## Overview

- **Framework tables**: Use prefix `base_` (managed by the framework)
- **Custom app tables**: Use your own prefix (e.g., `my_app_`, etc.)
- **Dual configuration**: Separate drizzle configs for framework and custom tables
- **Independent migrations**: Framework and custom tables are migrated separately

## 1. Define Custom Schema

Create your custom database schema in a file like `src/db-schema.ts`:

```typescript
import { pgTableCreator } from "drizzle-orm/pg-core";
import {
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

// Define your app's table prefix
export const PREFIX = "ai_coach_";

// Create table creator with your prefix
export const pgCustomAppTable = pgTableCreator((name) => `${PREFIX}${name}`);

type someSessionsMeta = {
  notes: string[];
};

// Define your custom tables
export const dbSchema = {
  // Example: Custom coaching sessions table
  someSessions: pgCustomAppTable("some_sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    sessionType: varchar("session_type", { length: 100 }).notNull(),
    status: varchar("status", { length: 50 }).notNull().default("pending"),
    goals: jsonb("goals"),
    notes: text("notes"),
    duration: integer("duration"), // in minutes
    scheduledAt: timestamp("scheduled_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    meta: jsonb("meta").$type<someSessionsMeta>().default({}),
  }),

  // Example: Custom progress tracking table
  progressTracking: pgCustomAppTable("progress_tracking", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    coachingSessionId: uuid("coaching_session_id"),
    metricType: varchar("metric_type", { length: 100 }).notNull(),
    value: jsonb("value").notNull(),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    metadata: jsonb("metadata"),
  }),

  // Example: Custom app settings table
  appSettings: pgCustomAppTable("app_settings", {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 255 }).notNull().unique(),
    value: text("value").notNull(),
    description: text("description"),
    isPublic: boolean("is_public").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  }),
};

// Export individual tables for easier imports
export const { coachingSessions, progressTracking, appSettings } = dbSchema;
```

### Export Types

```typescript
export type SomeSessions = typeof someSessions.$inferSelect;
export type SomeSessionsInsert = typeof someSessions.$inferInsert;
export type SomeSessionsUpdate = Partial<SomeSessions>;
```

## 2. Drizzle Configuration Files

You will need two drizzle configuration files. One for the framework tables and one for your custom tables.

### Custom App Tables Configuration (`drizzle.config.ts`)

```typescript
import { defineConfig } from "drizzle-kit";
import { PREFIX } from "./src/db-schema";

const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const POSTGRES_CA = process.env.POSTGRES_CA ?? "";
let POSTGRES_USE_SSL = !process.env.POSTGRES_USE_SSL
  ? true
  : process.env.POSTGRES_USE_SSL !== "false";

if (POSTGRES_CA && POSTGRES_CA.length > 0 && POSTGRES_CA !== "none") {
  POSTGRES_USE_SSL = true;
}

console.log("POSTGRES_USE_SSL is", POSTGRES_USE_SSL);
console.log(
  "Connect to database: ",
  `postgresql://${POSTGRES_USER}:***@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`
);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db-schema.ts",
  out: "./drizzle-sql",
  tablesFilter: PREFIX + "*", // Only manage tables with your prefix
  migrations: {
    table: `${PREFIX}migrations`, // Custom migrations table
  },
  dbCredentials: {
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    database: POSTGRES_DB,
    ...(POSTGRES_USE_SSL && {
      ssl: {
        rejectUnauthorized: false,
        ca: POSTGRES_CA && POSTGRES_CA.length > 0 ? POSTGRES_CA : undefined,
      },
    }),
    ...(POSTGRES_USE_SSL === false && {
      ssl: false,
    }),
  },
});
```

### Framework Tables Configuration (`drizzle.fastapp.config.ts`)

```typescript
import { defineConfig } from "drizzle-kit";

const PREFIX = "base_"; // Framework prefix

const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const POSTGRES_CA = process.env.POSTGRES_CA ?? "";
let POSTGRES_USE_SSL = !process.env.POSTGRES_USE_SSL
  ? true
  : process.env.POSTGRES_USE_SSL !== "false";

if (POSTGRES_CA && POSTGRES_CA.length > 0 && POSTGRES_CA !== "none") {
  POSTGRES_USE_SSL = true;
}

console.log(
  `RUN MIGRATIONS FOR "${PREFIX}" ON SERVER:${POSTGRES_HOST}, DB:${POSTGRES_DB}, USER:${POSTGRES_USER}, PORT:${POSTGRES_PORT}, PASSWORD:*** (SSL:${POSTGRES_USE_SSL})`
);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/fastapp-framework/src/lib/db/db-schema.ts", // Framework schema
  out: "./src/fastapp-framework/drizzle-sql",
  tablesFilter: PREFIX + "*", // Only framework tables
  migrations: {
    table: `${PREFIX}migrations`, // Framework migrations table
  },
  dbCredentials: {
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    database: POSTGRES_DB,
    ...(POSTGRES_USE_SSL && {
      ssl: {
        rejectUnauthorized: false,
        ca: POSTGRES_CA,
      },
    }),
    ...(POSTGRES_USE_SSL === false && {
      ssl: false,
    }),
  },
});
```

## 3. Package.json Scripts

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "fastapp:migrate": "drizzle-kit migrate --config drizzle.fastapp.config.ts",
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate"
  }
}
```

## 4. Migration Workflow

### Initial Setup

1. **Generate framework migrations** (first time setup):

   ```bash
   npm run fastapp:migrate
   ```

2. **Generate your custom table migrations**:

   ```bash
   npm run generate
   ```

3. **Apply your custom migrations**:
   ```bash
   npm run migrate
   ```

### Development Workflow

When you modify your custom schema:

1. **Generate new migration**:

   ```bash
   npm run generate
   ```

2. **Apply migration**:
   ```bash
   npm run migrate
   ```

### Framework Updates

When updating the fastapp-framework:

```bash
npm run fastapp:migrate
```

## 5. Using Custom Tables in Code

### Import and Use Tables

```typescript
import { coachingSessions, progressTracking } from "./db-schema";
import { db } from "./src/fastapp-framework/src/lib/db/database";

// Create a new coaching session
const newSession = await db
  .insert(coachingSessions)
  .values({
    userId: "user-uuid",
    sessionType: "goal-setting",
    status: "scheduled",
    goals: {
      primary: "Improve productivity",
      secondary: ["Better time management"],
    },
    scheduledAt: new Date("2024-01-15T10:00:00Z"),
  })
  .returning();

// Query sessions
const userSessions = await db
  .select()
  .from(coachingSessions)
  .where(eq(coachingSessions.userId, "user-uuid"));

// Update session
await db
  .update(coachingSessions)
  .set({
    status: "completed",
    completedAt: new Date(),
    notes: "Great progress on time management goals",
  })
  .where(eq(coachingSessions.id, sessionId));
```

### API Integration

```typescript
import { defineServer } from "./src/fastapp-framework";
import { coachingSessions } from "./src/db-schema";

const server = defineServer({
  // Custom API endpoints using your tables
  customRoutes: (app) => {
    // Get user coaching sessions
    app.get("/api/coaching/sessions/:userId", async (c) => {
      const userId = c.req.param("userId");
      const sessions = await db
        .select()
        .from(coachingSessions)
        .where(eq(coachingSessions.userId, userId));

      return c.json(sessions);
    });

    // Create new coaching session
    app.post("/api/coaching/sessions", async (c) => {
      const body = await c.req.json();
      const session = await db
        .insert(coachingSessions)
        .values(body)
        .returning();

      return c.json(session[0]);
    });
  },
});
```

## 6. Best Practices

### Table Naming

- Use descriptive table names
- Follow snake_case convention
- Keep prefixes short but meaningful

### Schema Design

- Include `id`, `createdAt`, and `updatedAt` fields
- Use UUIDs for primary keys
- Use appropriate data types (jsonb for flexible data, varchar with limits for constrained text)
- Add indexes for frequently queried columns

### Migration Safety

- Always generate migrations for schema changes
- Test migrations in development first
- Backup production database before running migrations
- Keep migration files in version control
