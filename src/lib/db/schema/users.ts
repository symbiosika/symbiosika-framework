/**
 * Schema definition for users and its direct related tables.
 */

import { sql } from "drizzle-orm";
import {
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  boolean,
  index,
  pgEnum,
  unique,
  integer,
  customType,
  bigint,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { relations } from "drizzle-orm";
import { teamSpecificData } from "./additional-data";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";
import * as v from "valibot";

export const organisations = pgBaseTable(
  "organisations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (organisations) => [unique("organisations_name_idx").on(organisations.name)]
);

export type OrganisationsSelect = typeof organisations.$inferSelect;
export type OrganisationsInsert = typeof organisations.$inferInsert;

export const organisationsSelectSchema = createSelectSchema(organisations);
export const organisationsInsertSchema = createInsertSchema(organisations);
export const organisationsUpdateSchema = createUpdateSchema(organisations);

const bytea = customType<{
  data: Buffer;
  default: false;
}>({
  dataType() {
    return "bytea";
  },
});

export const userProviderEnum = pgEnum("user_provider", [
  "local",
  "google",
  "microsoft",
]);

export const users = pgBaseTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: userProviderEnum("provider").notNull().default("local"),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    password: text("password"),
    salt: text("salt"),
    image: text("image"),
    firstname: varchar("firstname", { length: 255 }).notNull(),
    surname: varchar("surname", { length: 255 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 255 }),
    phoneNumberVerified: boolean("phone_number_verified")
      .notNull()
      .default(false),
    phoneNumberAsNumber: bigint("phone_number_as_number", { mode: "number" }),
    phonePinNumber: varchar("phone_pin_number", { length: 6 }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    extUserId: text("ext_user_id").notNull().default(""),
    meta: jsonb("meta"),
    profileImage: bytea("profile_image"),
    profileImageName: varchar("profile_image_name", { length: 255 }),
    profileImageContentType: varchar("profile_image_content_type", {
      length: 255,
    }),
    lastOrganisationId: uuid("last_organisation_id").references(
      () => organisations.id,
      {
        onDelete: "set null",
      }
    ),
  },
  (users) => [
    index("users_email_idx").on(users.email),
    uniqueIndex("unique_email").on(users.email),
    uniqueIndex("unique_phone_number").on(users.phoneNumber),
    uniqueIndex("unique_phone_number_as_number").on(users.phoneNumberAsNumber),
    index("users_created_at_idx").on(users.createdAt),
    index("users_updated_at_idx").on(users.updatedAt),
    index("users_email_verified_idx").on(users.emailVerified),
  ]
);

export type UsersSelect = typeof users.$inferSelect;
export type UsersInsert = typeof users.$inferInsert;
export type UserRestrictedSelect = Omit<UsersSelect, "password" | "salt">;
export type UserSelectBasic = {
  id: string;
  email: string;
  firstname: string;
  surname: string;
};

export const usersSelectSchema = createSelectSchema(users);
export const usersRestrictedSelectSchema = v.omit(usersSelectSchema, [
  "password",
  "salt",
]);
export const usersInsertSchema = createInsertSchema(users);
export const usersUpdateSchema = createUpdateSchema(users);

export const sessions = pgBaseTable(
  "sessions",

  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { mode: "string" }).notNull(),
  },
  (sessions) => [
    index("sessions_user_id_idx").on(sessions.userId),
    index("sessions_expires_idx").on(sessions.expires),
  ]
);

export type SessionsSelect = typeof sessions.$inferSelect;
export type SessionsInsert = typeof sessions.$inferInsert;

export const sessionsSelectSchema = createSelectSchema(sessions);
export const sessionsInsertSchema = createInsertSchema(sessions);
export const sessionsUpdateSchema = createUpdateSchema(sessions);

// User Permission Groups Table
export const userPermissionGroups = pgBaseTable(
  "user_permission_groups",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
  },
  (userPermissionGroups) => [
    index("user_permission_groups_name_idx").on(userPermissionGroups.name),
    index("user_permission_groups_created_at_idx").on(
      userPermissionGroups.createdAt
    ),
  ]
);

export type UserPermissionGroupsSelect =
  typeof userPermissionGroups.$inferSelect;
export type UserPermissionGroupsInsert =
  typeof userPermissionGroups.$inferInsert;

export const userPermissionGroupsSelectSchema =
  createSelectSchema(userPermissionGroups);
export const userPermissionGroupsInsertSchema =
  createInsertSchema(userPermissionGroups);
export const userPermissionGroupsUpdateSchema =
  createUpdateSchema(userPermissionGroups);

// User Group Members Table
export const userGroupMembers = pgBaseTable(
  "user_group_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userGroupId: uuid("user_groups_id")
      .notNull()
      .references(() => userPermissionGroups.id, { onDelete: "cascade" }),
  },
  (userGroupMember) => [
    primaryKey({
      columns: [userGroupMember.userId, userGroupMember.userGroupId],
    }),
  ]
);

export type UserGroupMembersSelect = typeof userGroupMembers.$inferSelect;
export type UserGroupMembersInsert = typeof userGroupMembers.$inferInsert;

export const userGroupMembersSelectSchema =
  createSelectSchema(userGroupMembers);
export const userGroupMembersInsertSchema =
  createInsertSchema(userGroupMembers);
export const userGroupMembersUpdateSchema =
  createUpdateSchema(userGroupMembers);

// Table "MagicLink Sessions"
export const magicLinkPurposeEnum = pgEnum("magic_link_purpose", [
  "login",
  "email_verification",
  "password_reset",
]);

export const magicLinkSessions = pgBaseTable(
  "magic_link_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    purpose: magicLinkPurposeEnum("purpose").notNull().default("login"),
  },
  (magicLinkSession) => [
    uniqueIndex("unique_token").on(magicLinkSession.token),
    index("magic_link_sessions_user_id_idx").on(magicLinkSession.userId),
    index("magic_link_sessions_expires_at_idx").on(magicLinkSession.expiresAt),
  ]
);

export type MagicLinkSessionsSelect = typeof magicLinkSessions.$inferSelect;
export type MagicLinkSessionsInsert = typeof magicLinkSessions.$inferInsert;

export const magicLinkSessionsSelectSchema =
  createSelectSchema(magicLinkSessions);
export const magicLinkSessionsInsertSchema =
  createInsertSchema(magicLinkSessions);
export const magicLinkSessionsUpdateSchema =
  createUpdateSchema(magicLinkSessions);

// Permission Type Enum
export const permissionTypeEnum = pgEnum("permission_type", ["regex"]);

// Path Permissions Table
export const pathPermissions = pgBaseTable(
  "path_permissions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    system: boolean("system").notNull().default(false), // if the permission is system-wide
    category: varchar("category", { length: 255 }).notNull(), // a category for the permission. e.g. "manage-teams"
    name: varchar("name", { length: 255 }).notNull(), // a unique name for the permission
    description: text("description"), // optional description for the permission
    type: permissionTypeEnum("type").notNull().default("regex"), // at the moment only regex is supported
    method: varchar("method", { length: 10 }).notNull(), // GET, POST, DELETE, PUT
    pathExpression: text("path_expression").notNull(), // e.g. "^/api/.*$"
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }), // optional
  },
  (permissions) => [
    unique("unique_category_name").on(permissions.category, permissions.name),
    index("permissions_method_idx").on(permissions.method),
    index("permissions_type_idx").on(permissions.type),
  ]
);

export type PathPermissionsSelect = typeof pathPermissions.$inferSelect;
export type PathPermissionsInsert = typeof pathPermissions.$inferInsert;

export const pathPermissionsSelectSchema = createSelectSchema(pathPermissions);
export const pathPermissionsInsertSchema = createInsertSchema(pathPermissions);
export const pathPermissionsUpdateSchema = createUpdateSchema(pathPermissions);

// Group to Permission Table

export const groupPermissions = pgBaseTable(
  "group_permissions",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => userPermissionGroups.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => pathPermissions.id, { onDelete: "cascade" }),
  },
  (groupPermissions) => [
    primaryKey({
      columns: [groupPermissions.groupId, groupPermissions.permissionId],
    }),
    index("group_permissions_group_id_idx").on(groupPermissions.groupId),
    index("group_permissions_permission_id_idx").on(
      groupPermissions.permissionId
    ),
  ]
);

export type GroupPermissionsSelect = typeof groupPermissions.$inferSelect;
export type GroupPermissionsInsert = typeof groupPermissions.$inferInsert;

export const groupPermissionsSelectSchema =
  createSelectSchema(groupPermissions);
export const groupPermissionsInsertSchema =
  createInsertSchema(groupPermissions);
export const groupPermissionsUpdateSchema =
  createUpdateSchema(groupPermissions);

// Teams Table
export const teams = pgBaseTable(
  "teams",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  },
  (teams) => [unique("teams_name_idx").on(teams.name)]
);

export type TeamsSelect = typeof teams.$inferSelect;
export type TeamsInsert = typeof teams.$inferInsert;

export const teamsSelectSchema = createSelectSchema(teams);
export const teamsInsertSchema = createInsertSchema(teams);
export const teamsUpdateSchema = createUpdateSchema(teams);

// Table team_members
export const teamMemberRoleEnum = pgEnum("team_member_role", [
  "admin",
  "member",
]);

export const teamMembers = pgBaseTable(
  "team_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: teamMemberRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { mode: "string" }).notNull().defaultNow(),
  },
  (teamMembers) => [
    primaryKey({
      columns: [teamMembers.userId, teamMembers.teamId],
    }),
  ]
);

export type TeamMembersSelect = typeof teamMembers.$inferSelect;
export type TeamMembersInsert = typeof teamMembers.$inferInsert;

export const teamMembersSelectSchema = createSelectSchema(teamMembers);
export const teamMembersInsertSchema = createInsertSchema(teamMembers);
export const teamMembersUpdateSchema = createUpdateSchema(teamMembers);

// RELATIONS
export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  userGroupMembers: many(userGroupMembers),
  teamMembers: many(teamMembers),
  organisationMembers: many(organisationMembers),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  users: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const pathPermissionsRelations = relations(
  pathPermissions,
  ({ many, one }) => ({
    groupPermissions: many(groupPermissions),
    organisation: one(organisations, {
      fields: [pathPermissions.organisationId],
      references: [organisations.id],
    }),
  })
);

export const userPermissionGroupsRelations = relations(
  userPermissionGroups,
  ({ many, one }) => ({
    userGroupMembers: many(userGroupMembers),
    groupPermissions: many(groupPermissions),
    organisation: one(organisations, {
      fields: [userPermissionGroups.organisationId],
      references: [organisations.id],
    }),
  })
);

export const userGroupMembersRelations = relations(
  userGroupMembers,
  ({ one }) => ({
    users: one(users, {
      fields: [userGroupMembers.userId],
      references: [users.id],
    }),
    userPermissionGroups: one(userPermissionGroups, {
      fields: [userGroupMembers.userGroupId],
      references: [userPermissionGroups.id],
    }),
  })
);

export const groupPermissionsRelations = relations(
  groupPermissions,
  ({ one }) => ({
    group: one(userPermissionGroups, {
      fields: [groupPermissions.groupId],
      references: [userPermissionGroups.id],
    }),
    permission: one(pathPermissions, {
      fields: [groupPermissions.permissionId],
      references: [pathPermissions.id],
    }),
  })
);

export const teamsRelations = relations(teams, ({ many, one }) => ({
  teamMembers: many(teamMembers),
  organisation: one(organisations, {
    fields: [teams.organisationId],
    references: [organisations.id],
  }),
  teamSpecificData: many(teamSpecificData),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
}));

export const organisationInvitationStatusEnum = pgEnum(
  "organisation_invitation_status",
  ["pending", "accepted", "declined"]
);

export const organisationMemberRoleEnum = pgEnum("organisation_member_role", [
  "owner",
  "admin",
  "member",
]);

export const organisationInvitations = pgBaseTable(
  "organisation_invitations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(), // cannot be the userId since a user is maybe not registered yet
    role: organisationMemberRoleEnum("role").notNull().default("member"),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 50 }).notNull().default("pending"), // Status der Einladung: pending, accepted, declined
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (organisationInvitations) => [
    uniqueIndex("unique_invitation").on(
      organisationInvitations.email,
      organisationInvitations.organisationId
    ),
    index("invitations_status_idx").on(organisationInvitations.status),
    index("invitations_created_at_idx").on(organisationInvitations.createdAt),
    index("invitations_email_idx").on(organisationInvitations.email),
  ]
);

export type OrganisationInvitationsSelect =
  typeof organisationInvitations.$inferSelect;
export type OrganisationInvitationsInsert =
  typeof organisationInvitations.$inferInsert;

export const organisationInvitationsSelectSchema = createSelectSchema(
  organisationInvitations
);
export const organisationInvitationsInsertSchema = createInsertSchema(
  organisationInvitations
);
export const organisationInvitationsUpdateSchema = createUpdateSchema(
  organisationInvitations
);

export const organisationMembers = pgBaseTable(
  "organisation_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    role: organisationMemberRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { mode: "string" }).notNull().defaultNow(),
  },
  (organisationMembers) => [
    primaryKey({
      columns: [organisationMembers.userId, organisationMembers.organisationId],
    }),
    index("organisation_members_user_id_idx").on(organisationMembers.userId),
    index("organisation_members_organisation_id_idx").on(
      organisationMembers.organisationId
    ),
  ]
);

export type OrganisationMembersSelect = typeof organisationMembers.$inferSelect;
export type OrganisationMembersInsert = typeof organisationMembers.$inferInsert;

export const organisationMembersSelectSchema =
  createSelectSchema(organisationMembers);
export const organisationMembersInsertSchema =
  createInsertSchema(organisationMembers);
export const organisationMembersUpdateSchema =
  createUpdateSchema(organisationMembers);

// Neue Beziehungen für organisationMembers

export const organisationMembersRelations = relations(
  organisationMembers,
  ({ one }) => ({
    user: one(users, {
      fields: [organisationMembers.userId],
      references: [users.id],
    }),
    organisation: one(organisations, {
      fields: [organisationMembers.organisationId],
      references: [organisations.id],
    }),
  })
);

// Invitation Codes Table
export const invitationCodes = pgBaseTable(
  "invitation_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    isActive: boolean("is_active").notNull().default(true),
    code: text("code").notNull(), // unique invitation code
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "string" }),
    maxUses: integer("max_uses").notNull().default(-1),
    usedCount: integer("used_count").notNull().default(0),
  },
  (invitationCodes) => [
    uniqueIndex("unique_invitation_code").on(invitationCodes.code),
    index("invitation_codes_organisation_id_idx").on(
      invitationCodes.organisationId
    ),
    index("invitation_codes_expires_at_idx").on(invitationCodes.expiresAt),
  ]
);

export type InvitationCodesSelect = typeof invitationCodes.$inferSelect;
export type InvitationCodesInsert = typeof invitationCodes.$inferInsert;

export const invitationCodesSelectSchema = createSelectSchema(invitationCodes);
export const invitationCodesInsertSchema = createInsertSchema(invitationCodes);
export const invitationCodesUpdateSchema = createUpdateSchema(invitationCodes);
