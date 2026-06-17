export const availableScopes = {
  all: [
    "ai:stt",
    "ai:tts",
    "ai:chat",
    "ai:chat-history:read",
    "ai:chat-history:write",
    "ai:generate-images",
    "ai:assistants:read",
    "ai:assistants:write",
    "ai:chat-groups:read",
    "ai:chat-groups:write",
    "ai:fine-tuning:read",
    "ai:fine-tuning:write",
    "ai:models:read",
    "ai:models:write",
    "knowledge:read",
    "knowledge:write",
    "knowledge-manage:read",
    "knowledge-manage:write",
    "ai:prompt-snippets:read",
    "ai:prompt-snippets:write",
    "ai:tools:read",
    "ai:tools:write",
    "app:logs",
    "files:read",
    "files:write",
    "jobs:read",
    "jobs:write",
    "user:read",
    "user:write",
    "payment:read",
    "payment:write",
    "teams:read",
    "teams:write",
    "secrets:read",
    "secrets:write",
    "plugins:read",
    "plugins:write",
    "permissions:read",
    "permissions:write",
    "tenants:read",
    "tenants:write",
    "workspaces:read",
    "workspaces:write",
    "webhooks:read",
    "webhooks:write",
    "connections:read",
    "connections:write",
    "robot-tasks:read",
    "robot-tasks:write",
    "robot-shifts:read",
    "robot-shifts:write",
  ],
};

export const validateScope = (scopes: string[]) => {
  const validScopes = availableScopes.all;
  const invalidScopes = scopes.filter((scope) => !validScopes.includes(scope));
  if (invalidScopes.length > 0) {
    throw new Error(`Invalid scope: ${invalidScopes.join(", ")}`);
  }
};

/**
 * Register additional scopes as valid at runtime.
 *
 * Apps (and the resource system) use this to make their own scopes known to the
 * framework so they pass token-creation validation and appear in the OAuth2
 * discovery metadata. Duplicates and empty values are ignored, so it is safe to
 * call repeatedly (e.g. once per resource at server-definition time).
 *
 * @example
 * registerScopes("robots:read", "robots:write");
 */
export const registerScopes = (...scopes: string[]) => {
  for (const scope of scopes) {
    if (scope && !availableScopes.all.includes(scope)) {
      availableScopes.all.push(scope);
    }
  }
};
