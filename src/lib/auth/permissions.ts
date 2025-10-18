import { and, eq, sql } from "drizzle-orm";
import {
  users,
  userGroupMembers,
  groupPermissions,
  pathPermissions,
} from "../db/schema/users";
import { getDb } from "../db/db-connection";
import log from "../log";

// Type definitions for the cache structure
type PathPermissionInfo = {
  path: string;
  type: "regex";
};

type MethodPermissionsMap = {
  [method: string]: PathPermissionInfo[];
};

type UserPermissionsCache = {
  [userId: string]: MethodPermissionsMap;
};

// Global cache instance
let permissionsCache: UserPermissionsCache = {};

export async function refreshPermissionsCache() {
  log.debug("Permissions cache is empty, refreshing");
  const newCache: UserPermissionsCache = {};

  // Get all relevant data in one query with joins
  const permissionsData = await getDb()
    .select({
      userId: users.id,
      method: pathPermissions.method,
      path: pathPermissions.pathExpression,
      type: pathPermissions.type,
    })
    .from(users)
    .innerJoin(userGroupMembers, eq(users.id, userGroupMembers.userId))
    .innerJoin(
      groupPermissions,
      eq(userGroupMembers.userGroupId, groupPermissions.groupId)
    )
    .innerJoin(
      pathPermissions,
      eq(groupPermissions.permissionId, pathPermissions.id)
    );

  // Organize the data into the cache structure
  for (const row of permissionsData) {
    const { userId, method, ...pathInfo } = row;

    // Initialize cache structures if they don't exist
    if (!newCache[userId]) {
      newCache[userId] = {};
    }
    if (!newCache[userId][method]) {
      newCache[userId][method] = [];
    }

    // Add permission to cache if it doesn't already exist
    const exists = newCache[userId][method].some(
      (p) => p.path === pathInfo.path
    );
    if (!exists) {
      newCache[userId][method].push(pathInfo);
    }
  }

  // Replace the old cache with the new one
  permissionsCache = newCache;

  return permissionsCache;
}

// Helper function to get permissions for a specific user
export async function getUserPermissions(
  userId: string
): Promise<MethodPermissionsMap | null> {
  if (Object.keys(permissionsCache).length === 0) {
    await refreshPermissionsCache();
  }
  return permissionsCache[userId] || null;
}

// Helper function to check if a user has permission for a specific path and method
export async function hasPermission(
  userId: string,
  method: string,
  path: string
): Promise<boolean> {
  if (Object.keys(permissionsCache).length === 0) {
    await refreshPermissionsCache();
  }

  const userPerms = permissionsCache[userId];
  if (!userPerms) return false;

  const methodPerms = userPerms[method];
  if (!methodPerms) return false;

  return methodPerms.some((perm) => {
    if (perm.type === "regex") {
      try {
        const regex = new RegExp(perm.path);
        return regex.test(path);
      } catch (e) {
        log.error(`Invalid regex pattern: ${perm.path}`);
        return false;
      }
    }
    return perm.path === path;
  });
}
