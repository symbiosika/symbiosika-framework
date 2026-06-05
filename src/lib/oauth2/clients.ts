/**
 * OAuth2 client management (admin-created, per tenant).
 *
 * Clients are created by a tenant admin. The `client_secret` (confidential
 * clients) is returned exactly once at creation / rotation and stored only as a
 * SHA-256 hash.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db/db-connection";
import { oauthClients } from "../db/db-schema";
import { revokeClientTokens } from "./tokens";
import { sha256hex } from "./util";

export type OAuthClientType = "public" | "confidential";

export type CreateClientParams = {
  tenantId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  clientType?: OAuthClientType;
  createdBy?: string;
};

const genClientId = () => "oc_" + nanoid(24);
const genClientSecret = () => nanoid(48);

const validateRedirectUris = (uris: string[]) => {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new Error("At least one redirect_uri is required");
  }
  for (const uri of uris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new Error(`Invalid redirect_uri: ${uri}`);
    }
    const isLocalhost =
      u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalhost)) {
      throw new Error(
        `redirect_uri must be https (or http on localhost): ${uri}`
      );
    }
  }
};

/**
 * Create a client. Returns the public `clientId` and, for confidential clients,
 * the plaintext `clientSecret` (shown only once).
 */
export const createOAuthClient = async (
  params: CreateClientParams
): Promise<{ clientId: string; clientSecret?: string }> => {
  validateRedirectUris(params.redirectUris);

  const clientType: OAuthClientType = params.clientType ?? "confidential";
  const clientId = genClientId();

  let clientSecret: string | undefined;
  let clientSecretHash: string | null = null;
  let tokenEndpointAuthMethod = "none";
  if (clientType === "confidential") {
    clientSecret = genClientSecret();
    clientSecretHash = sha256hex(clientSecret);
    tokenEndpointAuthMethod = "client_secret_post";
  }

  await getDb().insert(oauthClients).values({
    tenantId: params.tenantId,
    clientId,
    clientSecretHash,
    clientName: params.clientName,
    clientType,
    redirectUris: params.redirectUris,
    scopes: params.scopes,
    tokenEndpointAuthMethod,
    createdBy: params.createdBy ?? null,
  });

  return { clientId, clientSecret };
};

export type OAuthClientRow = typeof oauthClients.$inferSelect;

/** Look up a client by its public client_id (enabled clients only). */
export const getOAuthClient = async (
  clientId: string
): Promise<OAuthClientRow | null> => {
  const rows = await getDb()
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  const row = rows[0];
  if (!row || row.disabledAt) {
    return null;
  }
  return row;
};

/** Verify a presented client secret against the stored hash. */
export const verifyClientSecret = (
  client: OAuthClientRow,
  presentedSecret: string | undefined
): boolean => {
  if (!client.clientSecretHash) {
    return false;
  }
  if (!presentedSecret) {
    return false;
  }
  return sha256hex(presentedSecret) === client.clientSecretHash;
};

export const listClientsForTenant = async (tenantId: string) => {
  return getDb()
    .select({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      clientName: oauthClients.clientName,
      clientType: oauthClients.clientType,
      redirectUris: oauthClients.redirectUris,
      scopes: oauthClients.scopes,
      tokenEndpointAuthMethod: oauthClients.tokenEndpointAuthMethod,
      disabledAt: oauthClients.disabledAt,
      createdAt: oauthClients.createdAt,
    })
    .from(oauthClients)
    .where(eq(oauthClients.tenantId, tenantId));
};

const requireTenantClient = async (
  tenantId: string,
  id: string
): Promise<OAuthClientRow> => {
  const rows = await getDb()
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, id), eq(oauthClients.tenantId, tenantId)));
  if (!rows[0]) {
    throw new Error("Client not found");
  }
  return rows[0];
};

/** Rotate a confidential client's secret. Returns the new plaintext secret. */
export const rotateClientSecret = async (
  tenantId: string,
  id: string
): Promise<{ clientSecret: string }> => {
  const client = await requireTenantClient(tenantId, id);
  if (client.clientType !== "confidential") {
    throw new Error("Only confidential clients have a secret");
  }
  const clientSecret = genClientSecret();
  await getDb()
    .update(oauthClients)
    .set({
      clientSecretHash: sha256hex(clientSecret),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(oauthClients.id, id));
  return { clientSecret };
};

export const updateOAuthClient = async (
  tenantId: string,
  id: string,
  patch: {
    clientName?: string;
    redirectUris?: string[];
    scopes?: string[];
    disabled?: boolean;
  }
) => {
  await requireTenantClient(tenantId, id);
  if (patch.redirectUris) {
    validateRedirectUris(patch.redirectUris);
  }
  await getDb()
    .update(oauthClients)
    .set({
      ...(patch.clientName !== undefined && { clientName: patch.clientName }),
      ...(patch.redirectUris !== undefined && {
        redirectUris: patch.redirectUris,
      }),
      ...(patch.scopes !== undefined && { scopes: patch.scopes }),
      ...(patch.disabled !== undefined && {
        disabledAt: patch.disabled ? new Date().toISOString() : null,
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(oauthClients.id, id));
};

/** Delete a client and revoke all its outstanding tokens. */
export const deleteOAuthClient = async (tenantId: string, id: string) => {
  const client = await requireTenantClient(tenantId, id);
  await revokeClientTokens(client.clientId);
  await getDb().delete(oauthClients).where(eq(oauthClients.id, id));
};
