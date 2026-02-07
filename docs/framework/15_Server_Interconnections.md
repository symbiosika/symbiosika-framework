# Server Inter-connections

The framework provides a built-in system for establishing secure, authenticated connections between two server instances. This is primarily designed to enable a "Server-Client" architecture where a central server (Server) communicates with multiple edge instances (Clients).

## Purpose

The main goal of this system is to facilitate:
1.  **Secure Handshake**: establishing a trust relationship without shared passwords.
2.  **Automated Registration**: Clients can register themselves with the Server.
3.  **Data Synchronization**: The authenticated connection is the foundation for future WebSocket connections to sync database content (e.g., down-sync from Server to Client).

## Architecture

The system uses **RSA Key Pairs** for authentication:
*   Each side generates its own Public/Private key pair.
*   During registration, Public Keys are exchanged and stored.
*   Authentication is performed by signing a payload (timestamp + connection ID) with the Private Key.
*   The receiver verifies the signature using the stored Public Key.
*   If valid, a short-lived **JWT** is issued for the session.

## Workflow

### 1. Connection Initialization (Client Side)
The client initiates the connection:
1.  Client generates a local RSA key pair.
2.  Client authenticates with the Remote Server using credentials (email/password) to prove identity *initially*.
3.  Client sends its Public Key to the Remote Server.

### 2. Key Exchange (Server Side)
The server receives the request:
1.  Server generates its own local RSA key pair.
2.  Server stores the Client's Public Key.
3.  Server sends back its own Public Key.
4.  Client stores the Server's Public Key.

Now, both sides trust each other via certificates. The initial password is no longer needed for subsequent communications.

### 3. Authentication & Verification
To use the connection (e.g., for WebSockets):
1.  **Sign**: Sender signs a payload (`connectionId:timestamp`) with its Private Key.
2.  **Verify**: Receiver checks the signature with the stored Public Key.
3.  **Token**: If valid, a JWT is returned with `scope: "connection:sync"`.

## Service Methods

The `connectionsService` provides the core logic:

*   `generateKeyPair()`: Creates RSA 4096-bit keys.
*   `initializeConnection(...)`: Client-side method to start the handshake.
*   `acceptConnection(...)`: Server-side method to finalize handshake.
*   `authenticateConnection(...)`: Verifies a signed request and issues a JWT.
*   `verifyConnection(...)`: Checks if the remote server is reachable and accepts our keys.
*   `cleanupStaleConnections(days)`: Removes connections inactive for X days.

## API Endpoints

Routes are available under `/api/v1/tenant/:tenantId/connections`:

*   `POST /validate-credentials`: Checks remote login details and lists available tenants.
*   `POST /init`: Starts the connection process (Client).
*   `POST /exchange-keys`: Completes the handshake (Server).
*   `POST /authenticate`: Public endpoint to exchange a signature for a JWT.
*   `POST /:connectionId/verify`: Verifies the connection status.
*   `GET /`: Lists all active connections.
*   `DELETE /:connectionId`: Removes a connection.

