import { sql } from "drizzle-orm";
import {
  pgEnum,
  text,
  timestamp,
  uuid,
  integer,
  varchar,
  jsonb,
  vector,
  index,
  uniqueIndex,
  unique,
  check,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { pgBaseTable } from ".";
import { organisations, teams, users } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

// Enum for the type of file source
export const fileSourceTypeEnum = pgEnum("file_source_type", [
  "db",
  "local",
  "url",
  "text",
  "finetuning",
  "plugin",
  "external",
]);

// Table to store input texts
export const knowledgeText = pgBaseTable(
  "knowledge_text",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    organisationWide: boolean("organisation_wide").notNull().default(false),
    // optional team id to organize knowledge entries into teams.
    // security feature to limit access to knowledge entries
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    // optional user id to assign knowledge entries to a user.
    // security feature to limit access to knowledge entries
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    title: varchar("title", { length: 1000 }).notNull().default(""),
    meta: jsonb("meta").notNull().default("{}"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
  },
  (knowledgeText) => [
    index("knowledge_text_created_at_idx").on(knowledgeText.createdAt),
    index("knowledge_text_updated_at_idx").on(knowledgeText.updatedAt),
    index("knowledge_text_deleted_at_idx").on(knowledgeText.deletedAt),
    index("knowledge_text_title_idx").on(knowledgeText.title),
    index("knowledge_text_organisation_id_idx").on(
      knowledgeText.organisationId
    ),
    index("knowledge_text_team_id_idx").on(knowledgeText.teamId),
    index("knowledge_text_user_id_idx").on(knowledgeText.userId),
    check("knowledge_text_text_min_length", sql`length(text) > 3`),
  ]
);

export type KnowledgeTextSelect = typeof knowledgeText.$inferSelect;
export type KnowledgeTextInsert = typeof knowledgeText.$inferInsert;

export const knowledgeTextSchema = createSelectSchema(knowledgeText);
export const knowledgeTextInsertSchema = createInsertSchema(knowledgeText);
export const knowledgeTextUpdateSchema = createUpdateSchema(knowledgeText);

export type KnowledgeTextMeta = {
  sourceUri?: string;
  textLength?: number;
  includesLocalImages?: boolean; // when the document has mardown ![image](image.png) which can be found in the storage
};

// Table for knowledge groups (grouping of knowledge entries)
export const knowledgeGroup = pgBaseTable(
  "knowledge_group",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    organisationWideAccess: boolean("organisation_wide_access")
      .notNull()
      .default(false),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("knowledge_group_name_org_idx").on(table.name, table.organisationId),
    index("knowledge_group_organisation_id_idx").on(table.organisationId),
    index("knowledge_group_user_id_idx").on(table.userId),
  ]
);

export type KnowledgeGroupSelect = typeof knowledgeGroup.$inferSelect;
export type KnowledgeGroupInsert = typeof knowledgeGroup.$inferInsert;

export const knowledgeGroupSchema = createSelectSchema(knowledgeGroup);
export const knowledgeGroupInsertSchema = createInsertSchema(knowledgeGroup);
export const knowledgeGroupUpdateSchema = createUpdateSchema(knowledgeGroup);

// Assignments of knowledge groups to teams
export const knowledgeGroupTeamAssignments = pgBaseTable(
  "knowledge_group_team_assignments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    knowledgeGroupId: uuid("knowledge_group_id")
      .notNull()
      .references(() => knowledgeGroup.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("knowledge_group_team_assignment_unique").on(
      table.knowledgeGroupId,
      table.teamId
    ),
    index("knowledge_group_team_assignment_knowledge_group_id_idx").on(
      table.knowledgeGroupId
    ),
    index("knowledge_group_team_assignment_team_id_idx").on(table.teamId),
  ]
);

export type KnowledgeGroupTeamAssignmentSelect =
  typeof knowledgeGroupTeamAssignments.$inferSelect;
export type KnowledgeGroupTeamAssignmentInsert =
  typeof knowledgeGroupTeamAssignments.$inferInsert;

export const knowledgeGroupTeamAssignmentsSchema = createSelectSchema(
  knowledgeGroupTeamAssignments
);
export const knowledgeGroupTeamAssignmentsInsertSchema = createInsertSchema(
  knowledgeGroupTeamAssignments
);
export const knowledgeGroupTeamAssignmentsUpdateSchema = createUpdateSchema(
  knowledgeGroupTeamAssignments
);

// Relations for knowledge groups
export const knowledgeGroupRelations = relations(
  knowledgeGroup,
  ({ many }) => ({
    teamAssignments: many(knowledgeGroupTeamAssignments),
  })
);

// Relations for knowledge group team assignments
export const knowledgeGroupTeamAssignmentsRelations = relations(
  knowledgeGroupTeamAssignments,
  ({ one }) => ({
    knowledgeGroup: one(knowledgeGroup, {
      fields: [knowledgeGroupTeamAssignments.knowledgeGroupId],
      references: [knowledgeGroup.id],
    }),
    team: one(teams, {
      fields: [knowledgeGroupTeamAssignments.teamId],
      references: [teams.id],
    }),
  })
);

// Main table for all knowledge entries
export const knowledgeEntry = pgBaseTable(
  "knowledge_entry",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // optional team id to organize knowledge entries into teams.
    // security feature to limit access to knowledge entries
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    // optional user id to assign knowledge entries to a user.
    // security feature to limit access to knowledge entries
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // optional assign a document only to my user
    // security feature to limit access to knowledge entries
    userOwned: boolean("user_owned").notNull().default(false),
    // optional assign a document to a knowledge group
    knowledgeGroupId: uuid("knowledge_group_id").references(
      () => knowledgeGroup.id,
      { onDelete: "cascade" }
    ),
    parentId: uuid("parentId").references(
      (): AnyPgColumn => knowledgeEntry.id,
      {
        onDelete: "cascade",
      }
    ),
    name: varchar("name", { length: 1000 }).notNull(),
    description: text("description"),
    meta: jsonb("meta").$type<KnowledgeTextMeta>().default({}),
    version: integer("version").notNull().default(1),
    versionText: text("version_text").notNull().default("1"),
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
  },
  (knowledgeEntry) => [
    uniqueIndex("knowledgeentry_name_idx").on(
      knowledgeEntry.name,
      knowledgeEntry.parentId,
      knowledgeEntry.organisationId,
      knowledgeEntry.teamId,
      knowledgeEntry.userId,
      knowledgeEntry.version
    ),
    index("knowledgeentry_created_at_idx").on(knowledgeEntry.createdAt),
    index("knowledgeentry_updated_at_idx").on(knowledgeEntry.updatedAt),
    index("knowledgeentry_deleted_at_idx").on(knowledgeEntry.deletedAt),
    index("knowledgeentry_organisation_id_idx").on(
      knowledgeEntry.organisationId
    ),
    index("knowledge_entry_team_id_idx").on(knowledgeEntry.teamId),
    index("knowledge_entry_user_id_idx").on(knowledgeEntry.userId),
    check(
      "knowledge_entry_description_max_length",
      sql`length(description) <= 10000`
    ),
  ]
);

export type KnowledgeEntrySelect = typeof knowledgeEntry.$inferSelect;
export type KnowledgeEntryInsert = typeof knowledgeEntry.$inferInsert;

export const knowledgeEntrySchema = createSelectSchema(knowledgeEntry);
export const knowledgeEntryInsertSchema = createInsertSchema(knowledgeEntry);
export const knowledgeEntryUpdateSchema = createUpdateSchema(knowledgeEntry);

// Table to save the raw text chunks for each knowledge entry

export type KnowledgeChunkMeta = {
  sourceUri?: string;
  textLength?: number;
  page?: number;
};

export const knowledgeChunks = pgBaseTable(
  "knowledge_chunks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    knowledgeEntryId: uuid("knowledge_entry_id")
      .notNull()
      .references(() => knowledgeEntry.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    header: varchar("header", { length: 1000 }),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    embeddingModel: varchar("embedding_model", { length: 255 })
      .notNull()
      .default("")
      .notNull(),
    textEmbedding: vector("text_embedding", { dimensions: 1536 }).notNull(),
    meta: jsonb("meta").$type<KnowledgeChunkMeta>().default({}),
  },
  (knowledgeChunks) => [
    index("knowledge_chunks_knowledge_entry_id_idx").on(
      knowledgeChunks.knowledgeEntryId
    ),
    index("knowledge_chunks_created_at_idx").on(knowledgeChunks.createdAt),
    index("knowledge_chunks_header_idx").on(knowledgeChunks.header),
  ]
);

export type KnowledgeChunksSelect = typeof knowledgeChunks.$inferSelect;
export type KnowledgeChunksInsert = typeof knowledgeChunks.$inferInsert;

export const knowledgeChunksSchema = createSelectSchema(knowledgeChunks);
export const knowledgeChunksInsertSchema = createInsertSchema(knowledgeChunks);
export const knowledgeChunksUpdateSchema = createUpdateSchema(knowledgeChunks);

// Table for knowledge filters definition
// This table is used to define the filters for knowledge entries

export const knowledgeFilters = pgBaseTable(
  "knowledge_filters",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 50 }).notNull(), // z.B. 'department', 'topic', 'level'
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("knowledge_filters_name_type_unique").on(
      table.name,
      table.category
    ),
    index("knowledge_filters_category_name_idx").on(table.category, table.name),
  ]
);

export type KnowledgeFiltersSelect = typeof knowledgeFilters.$inferSelect;
export type KnowledgeFiltersInsert = typeof knowledgeFilters.$inferInsert;

export const knowledgeFiltersSchema = createSelectSchema(knowledgeFilters);
export const knowledgeFiltersInsertSchema =
  createInsertSchema(knowledgeFilters);
export const knowledgeFiltersUpdateSchema =
  createUpdateSchema(knowledgeFilters);

export const knowledgeEntryRelations = relations(
  knowledgeEntry,
  ({ many, one }) => ({
    knowledgeChunks: many(knowledgeChunks),
    organisation: one(organisations, {
      fields: [knowledgeEntry.organisationId],
      references: [organisations.id],
    }),
    team: one(teams, {
      fields: [knowledgeEntry.teamId],
      references: [teams.id],
    }),
    user: one(users, {
      fields: [knowledgeEntry.userId],
      references: [users.id],
    }),
    knowledgeGroup: one(knowledgeGroup, {
      fields: [knowledgeEntry.knowledgeGroupId],
      references: [knowledgeGroup.id],
    }),
  })
);

export const knowledgeChunksRelations = relations(
  knowledgeChunks,
  ({ one }) => ({
    knowledgeEntry: one(knowledgeEntry, {
      fields: [knowledgeChunks.knowledgeEntryId],
      references: [knowledgeEntry.id],
    }),
  })
);

export const knowledgeTextRelations = relations(
  knowledgeText,
  ({ many, one }) => ({
    organisation: one(organisations, {
      fields: [knowledgeText.organisationId],
      references: [organisations.id],
    }),
    team: one(teams, {
      fields: [knowledgeText.teamId],
      references: [teams.id],
    }),
    user: one(users, {
      fields: [knowledgeText.userId],
      references: [users.id],
    }),
  })
);
