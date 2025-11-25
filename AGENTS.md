# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Database Environment
- `docker compose up` - Start development database
- `docker compose down` - Stop development database

### Database Migrations
- `bun run fastapp:migrate` - Run database migrations. Should be run on each start of development server to be up to date.
- `bun run fastapp:generate` - Generate new migration files after schema changes

### Basic Development
- `bun dev` - Start development server with hot reload
- `bun dev:inspect` - Start development server with debugging
- `bun build` - Build TypeScript to JavaScript
- `bun clean` - Remove built files

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
- **usermanagement-service**: Authentication, organizations, teams, permissions
- **files-service**: File storage and management (local/S3)
- **plugin-service**: Extensible plugin system
- **job-service**: Background job processing with queues
- **secrets-service**: Secure configuration management
- **whatsapp-service**: WhatsApp Business API integration

### Route Structure
Organization-centric multi-tenant API design:
- `/user/*` - User management and authentication
- `/tenant/{orgId}/*` - Organization-scoped resources
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

### AI Integration Patterns
- Multi-provider AI support (OpenAI, Anthropic, Google, Mistral, etc.)
- RAG implementation with vector embeddings and semantic search
- Real-time chat with streaming responses
- Knowledge base with filtering and grouping
- Prompt template system with dynamic placeholders
- Document parsing (PDF, URL) with OCR support
- Model Context Protocol (MCP) for external tools

### Key Library Organization
- `src/lib/ai/` - Comprehensive AI capabilities and integrations
- `src/lib/auth/` - JWT authentication with multiple providers
- `src/lib/db/` - Database abstraction with Drizzle ORM
- `src/lib/plugins/` - Plugin architecture with encryption
- `src/lib/usermanagement/` - Organizations, teams, permissions

### Development Patterns
- Configuration-driven setup via `defineServer()` function
- Service-oriented architecture with clean separation
- Full TypeScript coverage with exported type definitions
- Plugin architecture for extensibility without core modification
- Multi-tenant resource isolation at organization level

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