# Backend Framework

This file provides guidance to work with this framework.

## Development Commands

### Database Environment
- `bun run docker:up` - Start development database
- `bun run docker:down` - Stop development database

### Database Migrations
- `bun run framework:migrate` - Run database migrations. Should be run on each start of development server to be up to date.
- `bun run framework:generate` - Generate new migration files after schema changes

### Server Development
- `bun run dev` - Start development server with hot reload

### Testing
- Run tests from root directory: `bun test src/path/to/file.test.ts`
- Never use `cd` commands for testing
- Use `initTests()` for database connection in tests
- Never mock functions - use real implementations with test data

## Architecture Overview

### Core Framework Design
FastApp Framework is a TypeScript backend framework built on Hono and Bun runtime, designed for rapid AI-powered application development with enterprise features.

### Key Services
- **ai-service**: Comprehensive AI/ML capabilities (chat, knowledge, embeddings)
- **usermanagement-service**: Authentication, tenants, teams, permissions
- **files-service**: File storage and management (local/S3)
- **plugin-service**: Extensible plugin system
- **job-service**: Background job processing with queues
- **secrets-service**: Secure configuration management
- **whatsapp-service**: WhatsApp Business API integration

### Route Structure
Tenant-centric multi-tenant API design:
- `/user/*` - User management and authentication
- `/tenant/{tenantId}/*` - Tenant-scoped resources
  - `/ai/*` - AI features (chat, knowledge, models, templates)
  - `/files/*` - File management
  - `/teams/*` - Team management
  - `/plugins/*` - Plugin management
  - `/jobs/*` - Background jobs
- `/admin/*` - Administrative endpoints

### Database Schema
Multi-tenant PostgreSQL schema with pgvector for AI features:
- Core tables: `users`, `tenants`, `workspaces`, `teams`
- AI tables: `chat`, `knowledge`, `embeddings`, `prompts`, `models`
- System tables: `jobs`, `logs`, `files`, `webhooks`, `plugins`
- Security tables: `secrets`, `api_tokens`

Database schema is defined in `src/lib/db/db-schema.ts` and its sub-folders.
The database ORM is Drizzle.

### Validation
Validation is done using Valibot!

### AI Integration Patterns
- Multi-provider AI support (OpenAI, Anthropic, Google, Mistral, etc.)
- RAG implementation with vector embeddings and semantic search
- Real-time chat with streaming responses
- Knowledge base with filtering and grouping
- Prompt template system with dynamic placeholders
- Document parsing (PDF, URL) with OCR support
- Model Context Protocol (MCP) for external tools

### Key Library tenant management
- `src/lib/ai/` - Comprehensive AI capabilities and integrations
- `src/lib/auth/` - JWT authentication with multiple providers
- `src/lib/db/` - Database abstraction with Drizzle ORM
- `src/lib/plugins/` - Plugin architecture with encryption
- `src/lib/usermanagement/` - tenants, teams, permissions

### Development Patterns
- Configuration-driven setup via `defineServer()` function
- Service-oriented architecture with clean separation
- Full TypeScript coverage with exported type definitions
- Plugin architecture for extensibility without core modification
- Multi-tenant resource isolation at tenant level

### Custom Routes (customHonoApps)
When adding custom routes to your application, use one of two options:

**`customHonoApps`** - Public routes without authentication
- Routes registered here are accessible without authentication
- Use for public endpoints like health checks, public APIs, etc.

**`customHonoAppsWithAuth`** - Protected routes with authentication
- Routes registered here are automatically protected by global auth middleware
- All routes in `customHonoAppsWithAuth` require authentication by default
- Security by design: Routes are protected unless explicitly placed in `customHonoApps`

Example:
```typescript
const server = defineServer({
  // Public routes (without auth)
  customHonoApps: [
    {
      baseRoute: "",
      app: (app) => {
        app.get("/public-endpoint", async (c) => { ... });
      },
    },
  ],
  // Protected routes (with auth)
  customHonoAppsWithAuth: [
    {
      baseRoute: "",
      app: (app) => {
        app.get("/protected-endpoint", async (c) => {
          const userId = c.get("usersId"); // Available due to global auth
        });
      },
    },
  ],
});
```

**Note**: The global auth middleware (`authAndSetUsersInfo`) is automatically applied to all routes in `customHonoAppsWithAuth`. You don't need to add it manually to each route.

### Testing Guidelines
- Use test data from `src/test/init.test.ts` and `/test/` folder
- Wrap API calls with `testFetcher` from `../../test/fetcher.test`
- All tests must use `beforeAll(async () => await initTests())`
- Use real database connections, never mock functions
- Handle async cleanup with `.then(() => {})` in `afterAll` due to Bun runtime limitations

### Important File Locations
- Main entry: `src/index.ts` (defineServer function)
- Database schema: `src/lib/db/db-schema.ts`
- Type definitions: `src/types.ts`
- Configuration: `drizzle.config.ts`
- Test utilities: `src/test/`

### Testing Patterns (Additional)
- All tests must be in a single `describe` block (Bun bug workaround)
- Use `expect(async () => await fn()).toThrow()` for error testing
- Response properties: `jsonResponse`, `textResponse`, `headers`
- Example assertion: `expect(response.jsonResponse?.success).toBe(true)`

### Request Validation
- Use Valibot schemas for request validation
- Schemas in route files or separate `validation.ts` files
- Use `@hono/valibot-validator` for route validation