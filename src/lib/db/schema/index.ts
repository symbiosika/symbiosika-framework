import { pgTableCreator } from "drizzle-orm/pg-core";

export const pgBaseTable = pgTableCreator((name) => `base_${name}`);
