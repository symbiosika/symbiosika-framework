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

export const tenants = pgBaseTable(
  "tenants",
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
  (tenants) => [unique("tenants_name_idx").on(tenants.name)]
);

export type TenantsSelect = typeof tenants.$inferSelect;
export type TenantsInsert = typeof tenants.$inferInsert;

export const tenantsSelectSchema = createSelectSchema(tenants);
export const tenantsInsertSchema = createInsertSchema(tenants);
export const tenantsUpdateSchema = createUpdateSchema(tenants);

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
  "auth0",
  "hanko",
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
    lastTenantId: uuid("last_tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
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

/**
 * WebAuthn / passkey credentials (FIDO2 discoverable credentials).
 */
export const webauthnCredentials = pgBaseTable(
  "webauthn_credentials",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** base64url-encoded credential ID */
    credentialId: text("credential_id").notNull(),
    /** COSE-encoded public key */
    publicKey: bytea("public_key").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull(),
    transports: jsonb("transports").$type<string[]>(),
    credentialDeviceType: varchar("credential_device_type", { length: 32 }),
    credentialBackedUp: boolean("credential_backed_up"),
    aaguid: varchar("aaguid", { length: 64 }),
    nickname: varchar("nickname", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "string" }),
  },
  (t) => [
    uniqueIndex("webauthn_credentials_credential_id_idx").on(t.credentialId),
    index("webauthn_credentials_user_id_idx").on(t.userId),
  ]
);

export type WebauthnCredentialsSelect = typeof webauthnCredentials.$inferSelect;
export type WebauthnCredentialsInsert = typeof webauthnCredentials.$inferInsert;

export const webauthnCredentialsSelectSchema =
  createSelectSchema(webauthnCredentials);
export const webauthnCredentialsInsertSchema =
  createInsertSchema(webauthnCredentials);
export const webauthnCredentialsUpdateSchema =
  createUpdateSchema(webauthnCredentials);

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
    tenantId: uuid("tenant_id").references(() => tenants.id, {
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
    tenantId: uuid("tenant_id").references(() => tenants.id, {
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
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
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
  webauthnCredentials: many(webauthnCredentials),
  userGroupMembers: many(userGroupMembers),
  teamMembers: many(teamMembers),
  tenantMembers: many(tenantMembers),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  users: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const webauthnCredentialsRelations = relations(
  webauthnCredentials,
  ({ one }) => ({
    user: one(users, {
      fields: [webauthnCredentials.userId],
      references: [users.id],
    }),
  })
);

export const pathPermissionsRelations = relations(
  pathPermissions,
  ({ many, one }) => ({
    groupPermissions: many(groupPermissions),
    tenant: one(tenants, {
      fields: [pathPermissions.tenantId],
      references: [tenants.id],
    }),
  })
);

export const userPermissionGroupsRelations = relations(
  userPermissionGroups,
  ({ many, one }) => ({
    userGroupMembers: many(userGroupMembers),
    groupPermissions: many(groupPermissions),
    tenant: one(tenants, {
      fields: [userPermissionGroups.tenantId],
      references: [tenants.id],
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
  tenant: one(tenants, {
    fields: [teams.tenantId],
    references: [tenants.id],
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

export const tenantInvitationStatusEnum = pgEnum("tenant_invitation_status", [
  "pending",
  "accepted",
  "declined",
]);

export const tenantMemberRoleEnum = pgEnum("tenant_member_role", [
  "owner",
  "admin",
  "member",
]);

export const tenantInvitations = pgBaseTable(
  "tenant_invitations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(), // cannot be the userId since a user is maybe not registered yet
    role: tenantMemberRoleEnum("role").notNull().default("member"),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 50 }).notNull().default("pending"), // Status der Einladung: pending, accepted, declined
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (tenantInvitations) => [
    uniqueIndex("unique_invitation").on(
      tenantInvitations.email,
      tenantInvitations.tenantId
    ),
    index("invitations_status_idx").on(tenantInvitations.status),
    index("invitations_created_at_idx").on(tenantInvitations.createdAt),
    index("invitations_email_idx").on(tenantInvitations.email),
  ]
);

export type TenantInvitationsSelect = typeof tenantInvitations.$inferSelect;
export type TenantInvitationsInsert = typeof tenantInvitations.$inferInsert;

export const tenantInvitationsSelectSchema =
  createSelectSchema(tenantInvitations);
export const tenantInvitationsInsertSchema =
  createInsertSchema(tenantInvitations);
export const tenantInvitationsUpdateSchema =
  createUpdateSchema(tenantInvitations);

export const tenantMembers = pgBaseTable(
  "tenant_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: tenantMemberRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { mode: "string" }).notNull().defaultNow(),
  },
  (tenantMembers) => [
    primaryKey({
      columns: [tenantMembers.userId, tenantMembers.tenantId],
    }),
    index("tenant_members_user_id_idx").on(tenantMembers.userId),
    index("tenant_members_tenant_id_idx").on(tenantMembers.tenantId),
  ]
);

export type TenantMembersSelect = typeof tenantMembers.$inferSelect;
export type TenantMembersInsert = typeof tenantMembers.$inferInsert;

export const tenantMembersSelectSchema = createSelectSchema(tenantMembers);
export const tenantMembersInsertSchema = createInsertSchema(tenantMembers);
export const tenantMembersUpdateSchema = createUpdateSchema(tenantMembers);

export const tenantMembersRelations = relations(tenantMembers, ({ one }) => ({
  user: one(users, {
    fields: [tenantMembers.userId],
    references: [users.id],
  }),
  tenant: one(tenants, {
    fields: [tenantMembers.tenantId],
    references: [tenants.id],
  }),
}));

// Invitation Codes Table
export const invitationCodes = pgBaseTable(
  "invitation_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    isActive: boolean("is_active").notNull().default(true),
    code: text("code").notNull(), // unique invitation code
    tenantId: uuid("tenant_id").references(() => tenants.id, {
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
    index("invitation_codes_tenant_id_idx").on(invitationCodes.tenantId),
    index("invitation_codes_expires_at_idx").on(invitationCodes.expiresAt),
  ]
);

export type InvitationCodesSelect = typeof invitationCodes.$inferSelect;
export type InvitationCodesInsert = typeof invitationCodes.$inferInsert;

export const invitationCodesSelectSchema = createSelectSchema(invitationCodes);
export const invitationCodesInsertSchema = createInsertSchema(invitationCodes);
export const invitationCodesUpdateSchema = createUpdateSchema(invitationCodes);

// Message type enum
export const messageTypeEnum = pgEnum("message_type", [
  "info",
  "warning",
  "error",
]);

// User messages table
export const userMessages = pgBaseTable(
  "user_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    messageType: messageTypeEnum("message_type").notNull().default("info"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { mode: "string" }),
  },
  (table) => [
    index("user_messages_user_id_idx").on(table.userId),
    index("user_messages_confirmed_at_idx").on(table.confirmedAt),
    index("user_messages_created_at_idx").on(table.createdAt),
    index("user_messages_message_type_idx").on(table.messageType),
  ]
);

export const userMessagesRelations = relations(userMessages, ({ one }) => ({
  user: one(users, {
    fields: [userMessages.userId],
    references: [users.id],
  }),
}));

export type UserMessagesSelect = typeof userMessages.$inferSelect;
export type UserMessagesInsert = typeof userMessages.$inferInsert;

export const userMessagesSelectSchema = createSelectSchema(userMessages);
export const userMessagesInsertSchema = createInsertSchema(userMessages);
export const userMessagesUpdateSchema = createUpdateSchema(userMessages);