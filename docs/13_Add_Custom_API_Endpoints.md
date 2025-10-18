# Adding Custom API Endpoints

This guide explains how to create and secure custom API endpoints in the fastapp-framework.

## Overview

The fastapp-framework allows you to add custom API routes using Hono.js with built-in authentication, validation, database access, and encryption services. Custom routes are defined as functions that accept a `FastAppHono` app instance and register endpoints on it.

## Basic Structure

### 1. Create Route Definition Function

Create a function that defines your routes and accepts a `FastAppHono` app instance:

```typescript
import {
  type FastAppHono,
  HTTPException,
  middlewareService,
  secretsService,
  log,
} from "fastapp-framework";
import { resolver, validator } from "hono-openapi/valibot";
import * as v from "valibot";
import { getDb } from "fastapp-framework/dbSchema";

export function defineMyCustomRoutes(app: FastAppHono) {
  // Your routes will be defined here
}
```

### 2. Define Individual Routes

Add routes with appropriate HTTP methods, middleware, and validation:

```typescript
export function defineMyCustomRoutes(app: FastAppHono) {
  /**
   * GET endpoint with authentication and validation
   */
  app.get(
    "/my-endpoint/:id",
    middlewareService.authAndSetUsersInfo, // Authentication middleware
    validator(
      "param",
      v.object({
        id: v.string(),
      })
    ),
    async (c) => {
      const userId = c.get("usersId"); // Get authenticated user ID
      const { id } = c.req.valid("param"); // Get validated parameters
      
      try {
        // Your business logic here
        const data = await getMyData(userId, id);
        return c.json(data);
      } catch (error) {
        throw new HTTPException(500, {
          message: error.toString(),
        });
      }
    }
  );

  /**
   * POST endpoint with body validation
   */
  app.post(
    "/my-endpoint",
    middlewareService.authAndSetUsersInfo,
    validator(
      "json",
      v.object({
        name: v.string(),
        email: v.pipe(v.string(), v.email()),
        age: v.optional(v.number()),
      })
    ),
    async (c) => {
      const userId = c.get("usersId");
      const body = c.req.valid("json");
      
      try {
        const result = await createMyData(userId, body);
        return c.json(result, 201);
      } catch (error) {
        throw new HTTPException(500, {
          message: error.toString(),
        });
      }
    }
  );
}
```

## Authentication & Security

### Built-in Authentication Middleware

Use `middlewareService.authAndSetUsersInfo` to secure endpoints:

```typescript
app.get(
  "/secure-endpoint",
  middlewareService.authAndSetUsersInfo, // Validates JWT and sets user info
  async (c) => {
    const userId = c.get("usersId"); // Authenticated user ID
    const userEmail = c.get("usersEmail"); // User email
    const orgId = c.get("organisationId"); // User's organization ID
    
    // Your secure logic here
  }
);
```

### User-Specific Data Access

Always ensure users can only access their own data:

```typescript
const getUserData = async (userId: string, dataId: string) => {
  const data = await getDb()
    .select()
    .from(myTable)
    .where(
      and(
        eq(myTable.userId, userId), // Security: filter by user ID
        eq(myTable.id, dataId)
      )
    );
  
  if (!data.length) {
    throw new HTTPException(404, { message: "Data not found" });
  }
  
  return data[0];
};
```

## Request Validation

### Parameter Validation

Validate URL parameters using valibot schemas:

```typescript
app.get(
  "/endpoint/:id/:status",
  validator(
    "param",
    v.object({
      id: v.pipe(v.string(), v.uuid()), // UUID validation
      status: v.picklist(["active", "inactive"]), // Enum validation
    })
  ),
  async (c) => {
    const { id, status } = c.req.valid("param");
    // Parameters are now validated and type-safe
  }
);
```

### Body Validation

Validate JSON request bodies:

```typescript
app.post(
  "/endpoint",
  validator(
    "json",
    v.object({
      name: v.pipe(v.string(), v.minLength(1)), // Required string
      email: v.pipe(v.string(), v.email()), // Email validation
      age: v.optional(v.pipe(v.number(), v.minValue(18))), // Optional number with constraint
      tags: v.optional(v.array(v.string())), // Optional array
    })
  ),
  async (c) => {
    const body = c.req.valid("json");
    // Body is validated and type-safe
  }
);
```

### Query Parameter Validation

Validate query parameters:

```typescript
app.get(
  "/endpoint",
  validator(
    "query",
    v.object({
      page: v.optional(v.pipe(v.string(), v.transform(Number), v.minValue(1))),
      limit: v.optional(v.pipe(v.string(), v.transform(Number), v.maxValue(100))),
      filter: v.optional(v.string()),
    })
  ),
  async (c) => {
    const { page = 1, limit = 10, filter } = c.req.valid("query");
    // Query parameters are validated and transformed
  }
);
```

## Database Operations

### Using Drizzle ORM

Access the database using the framework's Drizzle instance:

```typescript
import { getDb } from "fastapp-framework/dbSchema";
import { and, eq, desc, asc } from "drizzle-orm";
import { myTable } from "../db-schema"; // Your custom schema

const getMyData = async (userId: string, filters: any) => {
  const db = getDb();
  
  // Select with conditions
  const data = await db
    .select()
    .from(myTable)
    .where(
      and(
        eq(myTable.userId, userId),
        filters.status ? eq(myTable.status, filters.status) : undefined
      )
    )
    .orderBy(desc(myTable.createdAt))
    .limit(10);
  
  return data;
};

const createMyData = async (userId: string, data: any) => {
  const db = getDb();
  
  const [inserted] = await db
    .insert(myTable)
    .values({
      userId,
      ...data,
      createdAt: new Date(),
    })
    .returning();
  
  return inserted;
};

const updateMyData = async (userId: string, id: string, updates: any) => {
  const db = getDb();
  
  const [updated] = await db
    .update(myTable)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(myTable.id, id),
        eq(myTable.userId, userId) // Security: ensure user owns the data
      )
    )
    .returning();
  
  if (!updated) {
    throw new HTTPException(404, { message: "Data not found" });
  }
  
  return updated;
};
```

## Data Encryption

### Encrypting Sensitive Data

Use the framework's encryption service for sensitive data:

```typescript
import { secretsService } from "fastapp-framework";

const storeSensitiveData = async (userId: string, sensitiveData: any) => {
  // Encrypt the data
  const encryptedData = secretsService.encryptAes(
    JSON.stringify(sensitiveData)
  );
  
  // Store encrypted data
  await getDb()
    .insert(userSpecificData)
    .values({
      userId,
      key: "sensitive_info",
      data: encryptedData,
      version: 1,
    });
};

const getSensitiveData = async (userId: string) => {
  const [record] = await getDb()
    .select()
    .from(userSpecificData)
    .where(
      and(
        eq(userSpecificData.userId, userId),
        eq(userSpecificData.key, "sensitive_info")
      )
    );
  
  if (!record) {
    return null;
  }
  
  // Decrypt the data
  const decryptedData = secretsService.decryptAes(record.data);
  return JSON.parse(decryptedData);
};
```

## Error Handling

### HTTP Exceptions

Use `HTTPException` for proper error responses:

```typescript
import { HTTPException } from "fastapp-framework";

// Client errors (4xx)
throw new HTTPException(400, { message: "Invalid request data" });
throw new HTTPException(401, { message: "Unauthorized" });
throw new HTTPException(403, { message: "Forbidden" });
throw new HTTPException(404, { message: "Resource not found" });

// Server errors (5xx)
throw new HTTPException(500, { message: "Internal server error" });
```

### Try-Catch Blocks

Always wrap business logic in try-catch blocks:

```typescript
app.post("/endpoint", async (c) => {
  try {
    const result = await processData();
    return c.json(result);
  } catch (error) {
    log.error("Error processing data:", error);
    throw new HTTPException(500, {
      message: "Failed to process data",
    });
  }
});
```

## Logging

Use the framework's logging service:

```typescript
import { log } from "fastapp-framework";

app.post("/endpoint", async (c) => {
  const userId = c.get("usersId");
  
  log.info("Processing request for user:", userId);
  log.debug("Request data:", requestData);
  
  try {
    const result = await processData();
    log.info("Successfully processed data for user:", userId);
    return c.json(result);
  } catch (error) {
    log.error("Error processing data:", error);
    throw new HTTPException(500, { message: "Processing failed" });
  }
});
```

## Integration with Main Server

### Register Custom Routes

In your main server file (e.g., `src/index.ts`), register your custom routes using the `customHonoApps` configuration:

```typescript
import { defineServer } from "./fastapp-framework/src";
import { defineMyCustomRoutes } from "./lib/routes/my-custom-routes";

const server = defineServer({
  appName: "My Application",
  // ... other configuration
  
  customHonoApps: [
    {
      baseRoute: "/app", // Base path for your routes
      app: defineMyCustomRoutes,   // Your route definition function
    },
    {
      baseRoute: "/admin",
      app: defineAdminRoutes,
    },
  ],
  
  // ... rest of configuration
});
```

### Route Accessibility

With the above configuration:
- Routes defined in `defineMyCustomRoutes` will be accessible under `/app/`
- For example: `app.get("/data/:id", ...)` becomes `GET /app/data/:id`
