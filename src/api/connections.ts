/**
 * @framework/connections — server-to-server connection management.
 *
 * The `connectionsService` facade plus the individual lookup/crypto helpers
 * used when verifying signed requests between connected servers.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  connectionsService,
  getConnection,
  getConnectionByTenantAndName,
  getConnectionByRemoteConnectionId,
  getConnectionByLocalTenant,
  verifySignature,
  signData,
  generateKeyPair,
  authenticateConnection,
  disconnectConnection,
  disconnectLocalConnections,
  teardownConnectionBySignature,
  ConnectionNotFoundError,
  ConnectionGoneError,
} from "../lib/connections";
