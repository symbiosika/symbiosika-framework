# Server-to-Server Connections

This guide explains how to establish secure server-to-server connections using the FastApp Framework's connection system.

## Overview

The connection system allows two FastApp Framework servers to establish secure, bidirectional WebSocket connections. Each connection is authenticated using either API tokens or username/password credentials, and secured using Ed25519 public key cryptography.

## Architecture

### Connection Flow

1. **Server A** wants to connect to **Server B**
2. **Server A** authenticates with **Server B** using credentials (API token or username/password)
3. **Server A** calls `/init` endpoint on **Server B** to create a connection
4. **Server B** generates a connection with public/private key pair and returns a short-lived connect token
5. **Server A** calls `/connect` endpoint on **Server B** with the connect token and its own public key
6. **Server B** validates the token and returns a WebSocket key
7. **Server A** establishes a WebSocket connection using the WebSocket key
8. Both servers store the connection details in their databases

### Database Schema

The connections table includes the following key fields:

- `organisationId` - Organisation that owns this connection
- `name` - Optional friendly name for the connection
- `remoteUrl` - Base URL of the remote server
- `remoteOrganisationId` - Organisation ID on the remote server
- `remoteConnectionId` - Connection ID on the remote server (for bidirectional reference)
- `initiatedBy` - Whether connection was initiated by "client" or "server"
- `status` - Connection status: "pending", "active", "disconnected", "revoked"
- `localPublicKey` / `localPrivateKey` - Ed25519 key pair for this connection
- `remotePublicKey` - Public key from the remote server
- `authenticationType` - "none", "api_token", or "basic_auth"
- `remoteCredentials` - Encrypted credentials for remote server (API token or username:password)
- `meta` - JSON field storing wsKey and other connection metadata

## API Endpoints

The API has two types of endpoints:
- **[OUTGOING]**: Used by this server to initiate connections to remote servers
- **[INCOMING]**: Called by remote servers when they want to connect to this server

### Outgoing Endpoints

#### 1. Connect to Remote Server [OUTGOING]

**POST** `/organisation/{organisationId}/connections/connect-to-server`

Creates a connection to a remote server.

**Authentication:** Bearer token (requires `connections:write` scope)

**Request Body:**
```json
{
  "name": "Connection to Server B",
  "remoteBaseUrl": "https://server-b.example.com/api/v1",
  "remoteOrganisationId": "uuid-of-org-on-server-b",
  "authenticationType": "api_token",
  "credentials": "your-api-token"
}
```

For username/password authentication:
```json
{
  "name": "Connection to Server B",
  "remoteBaseUrl": "https://server-b.example.com/api/v1",
  "remoteOrganisationId": "uuid-of-org-on-server-b",
  "authenticationType": "basic_auth",
  "credentials": "username:password"
}
```

**Response:**
```json
{
  "localConnectionId": "uuid-of-local-connection",
  "remoteConnectionId": "uuid-of-remote-connection"
}
```

### Incoming Endpoints

These endpoints are called by remote servers when they want to connect to this server.

#### 2. Initialize Connection [INCOMING]

**POST** `/organisation/{organisationId}/connections/init`

Creates a new connection entry and returns connection details with a short-lived connect token. This endpoint is automatically called by remote servers when they use the `/connect-to-server` endpoint.

**Authentication:** Bearer token (requires `connections:write` scope)

**Request Body:**
```json
{
  "name": "Connection from Server A",
  "initiatedBy": "server"
}
```

**Response:**
```json
{
  "id": "connection-uuid",
  "organisationId": "org-uuid",
  "localPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "status": "pending",
  "meta": {
    "connectToken": "short-lived-token",
    "connectTokenExp": 1234567890
  }
}
```

#### 3. Connect Using Token [INCOMING]

**POST** `/organisation/{organisationId}/connections/connect`

Validates the connect token and establishes the connection. This endpoint is automatically called by remote servers when they use the `/connect-to-server` endpoint.

**No authentication required** (uses connect token for validation instead)

**Request Body:**
```json
{
  "connectionId": "connection-uuid",
  "connectToken": "short-lived-token",
  "clientPublicKey": "-----BEGIN PUBLIC KEY-----\n..."
}
```

**Response:**
```json
{
  "status": "ok",
  "wsKey": "websocket-key-for-connection"
}
```

#### 4. WebSocket Connection

**GET** `/organisation/{organisationId}/connections/{connectionId}/ws?key={wsKey}`

Establishes the WebSocket connection. The wsKey is provided in the connect response. This endpoint is used by both incoming and outgoing connections.

**No authentication required** (uses wsKey for validation)

#### 5. Reconnect [INCOMING]

**POST** `/organisation/{organisationId}/connections/{connectionId}/reconnect`

Generates a new WebSocket key for an existing connection. Called by remote servers when they need to reconnect after a disconnection.

**Authentication:** Bearer token (requires `connections:write` scope)

**Response:**
```json
{
  "wsKey": "new-websocket-key"
}
```

### Management Endpoints

#### 6. List Connections

**GET** `/organisation/{organisationId}/connections`

Lists all connections for an organisation (both incoming and outgoing).

**Authentication:** Bearer token (requires `connections:read` scope)

**Response:**
```json
[
  {
    "id": "connection-uuid",
    "organisationId": "org-uuid",
    "name": "Connection to Server B",
    "remoteUrl": "https://server-b.example.com/api/v1",
    "remoteOrganisationId": "remote-org-uuid",
    "remoteConnectionId": "remote-connection-uuid",
    "initiatedBy": "server",
    "status": "active",
    "authenticationType": "api_token",
    "localPublicKey": "-----BEGIN PUBLIC KEY-----\n...",
    "remotePublicKey": "-----BEGIN PUBLIC KEY-----\n...",
    "createdAt": "2025-10-25T12:00:00Z",
    "updatedAt": "2025-10-25T12:01:00Z",
    "lastConnectedAt": "2025-10-25T12:01:00Z"
  }
]
```

#### 7. Close Connection

**DELETE** `/organisation/{organisationId}/connections/{connectionId}`

Closes the WebSocket and marks the connection as revoked.

**Authentication:** Bearer token (requires `connections:write` scope)

**Response:**
```json
{
  "status": "closed"
}
```

## Usage Examples

### Example 1: Connect Two Servers

**Server A wants to connect to Server B**

1. On **Server A**, call the connect-to-server endpoint:

```bash
curl -X POST https://server-a.example.com/api/v1/organisation/{orgId}/connections/connect-to-server \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Connection to Server B",
    "remoteBaseUrl": "https://server-b.example.com/api/v1",
    "remoteOrganisationId": "server-b-org-uuid",
    "authenticationType": "api_token",
    "credentials": "api-token-for-server-b"
  }'
```

2. The system automatically:
   - Creates a local connection entry on **Server A**
   - Authenticates with **Server B** using the provided credentials
   - Calls `/init` on **Server B** to create a connection
   - Calls `/connect` on **Server B** to establish the connection
   - Opens a WebSocket connection
   - Stores connection details on both servers

### Example 2: Using the Connection Service Programmatically

```typescript
import { connectionsService } from "@framework/lib/connections";

// Connect to a remote server
const result = await connectionsService.connectToServer({
  organisationId: "local-org-id",
  remoteBaseUrl: "https://remote.example.com/api/v1",
  remoteOrganisationId: "remote-org-id",
  authenticationType: "basic_auth",
  credentials: "username:password",
  name: "My Connection",
  createdByUserId: "user-id"
});

console.log("Connected:", result.localConnectionId, result.remoteConnectionId);

// Send a message
connectionsService.sendJson(result.localConnectionId, {
  type: "greeting",
  message: "Hello from Server A"
});

// Listen for messages
const unsubscribe = connectionsService.onMessage(result.localConnectionId, (message) => {
  console.log("Received:", message);
});

// Later: reconnect if connection drops (uses stored credentials)
try {
  await connectionsService.reconnect(result.localConnectionId);
  console.log("Reconnected successfully");
} catch (error) {
  console.error("Reconnection failed:", error);
}

// Close connection
connectionsService.close(result.localConnectionId);
```

**Note:** The `reconnect()` method automatically retrieves stored credentials from the database, re-authenticates with the remote server if needed, and re-establishes the WebSocket connection. You don't need to provide credentials again.

### Example 3: Handling Messages

```typescript
import { connectionsService } from "@framework/lib/connections";

// Listen to all messages from all connections
const unsubscribe = connectionsService.onAnyMessage((connectionId, message) => {
  console.log(`Message from ${connectionId}:`, message);
  
  // Echo back
  connectionsService.sendJson(connectionId, {
    type: "echo",
    original: message
  });
});

// List all open connections
const openConnections = connectionsService.listOpen();
console.log("Open connections:", openConnections);

// List connections for specific organisation
const orgConnections = connectionsService.listOpen("org-uuid");
```

## Security Considerations

1. **Credentials Storage**: All remote credentials are encrypted using AES-256-CBC before being stored in the database. The encryption keys are managed via environment variables (`SECRETS_AES_KEY` and `SECRETS_AES_IV`).

2. **Public Key Cryptography**: Each connection uses Ed25519 key pairs for additional security. The private keys are also encrypted before storage.

3. **Short-Lived Tokens**: Connect tokens are valid for only 60 seconds by default, minimizing the window for token replay attacks.

4. **WebSocket Keys**: WebSocket connections require a unique key that is generated after successful token validation.

5. **Authentication Types**:
   - **API Token**: Direct token usage, best for server-to-server connections
   - **Basic Auth**: Username/password login to get a JWT token, best for user-initiated connections

## Error Handling

The system includes comprehensive error handling:

- Failed authentication attempts are logged
- Failed connections are marked as "revoked" in the database
- WebSocket connections have 30-second timeouts
- Reconnection logic automatically retrieves new tokens if needed

## Database Migration

After modifying the connections schema, generate and run migrations:

```bash
# Generate migration
bun run framework:generate

# Apply migration
bun run framework:migrate
```

## Environment Variables

Required environment variables for encryption:

```env
SECRETS_AES_KEY=your-256-bit-key-in-hex
SECRETS_AES_IV=your-128-bit-iv-in-hex
```

The system will automatically generate these if they don't exist and exit with instructions to add them to your `.env` file.

