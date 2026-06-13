# Symbiosika Framework

This repo contains a typeScript backend based on Hono + Bun + Postgre + DrizzleORM.

## Rules

- Always create unit tests for new routes and business logic
- Run tests until green before finishing: `bun test src/path/to/file.test.ts`

## Quick Reference

- `bun run dev` - Start dev server
- `bun run framework:migrate` - Run migrations
- `bun run framework:generate` - Generate migrations after schema changes
- `bun test src/path/to/file.test.ts` - Run tests
