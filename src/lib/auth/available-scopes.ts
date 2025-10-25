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
    "organisations:read",
    "organisations:write",
    "workspaces:read",
    "workspaces:write",
    "webhooks:read",
    "webhooks:write",
    "connections:read",
    "connections:write",
  ],
};

export const validateScope = (scopes: string[]) => {
  const validScopes = availableScopes.all;
  const invalidScopes = scopes.filter((scope) => !validScopes.includes(scope));
  if (invalidScopes.length > 0) {
    throw new Error(`Invalid scope: ${invalidScopes.join(", ")}`);
  }
};
