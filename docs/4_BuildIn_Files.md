# Built-in File Management

## Overview

The Fastapp Framework provides a built-in file management system for organizations. These endpoints allow you to upload, retrieve, get info, and delete files either in the database or on the local disk. All routes are protected by JWT authentication and permission checks.

---

## API Route Prefix

All file management API routes are prefixed with `/api/v1/` by default. For example, uploading a file is available at `/api/v1/organisation/:organisationId/files/:type/:bucket`.

---

## File Endpoints

The following endpoints are available for managing files within an organization:

- **POST `/api/v1/organisation/:organisationId/files/:type/:bucket`**  
  Upload a file to a specific bucket, either to the database (`type=db`) or local disk (`type=local`). Only organization admins can upload files.
  **Params:**
    - `organisationId` (string, URL param)
    - `type` ("db" | "local", URL param)
    - `bucket` (string, URL param)
  **Body:**
  Multipart form-data with at least a `file` field. Optionally, you can include `chatId` and `workspaceId` fields.
  **Response:**
  ```json
  {
    "path": "string",
    "id": "string",
    "name": "string",
    "organisationId": "string"
  }
  ```

- **GET `/api/v1/organisation/:organisationId/files/:type/:bucket/:filename`**  
  Retrieve a file by filename from a specific bucket (database or local disk). Only organization members can access files.
  **Params:**
    - `organisationId` (string, URL param)
    - `type` ("db" | "local", URL param)
    - `bucket` (string, URL param)
    - `filename` (string, URL param)
  **Response:**
    - Returns the file as a binary response with the correct `Content-Type` header.

- **GET `/api/v1/organisation/:organisationId/files/:type/:bucket/:id/info`**  
  Get metadata/info about a file by its ID (only for files stored in the database). Only organization members can access file info.
  **Params:**
    - `organisationId` (string, URL param)
    - `type` (must be "db", URL param)
    - `bucket` (string, URL param)
    - `id` (string, URL param)
  **Response:**
  ```json
  {
    "id": "string",
    "name": "string",
    "fileType": "string",
    "extension": "string",
    "createdAt": "string",
    "updatedAt": "string",
    "organisationId": "string",
    "bucket": "string",
    "chatId": "string | null",
    "workspaceId": "string | null",
    "expiresAt": "string | null"
  }
  ```

- **DELETE `/api/v1/organisation/:organisationId/files/:type/:bucket/:id`**  
  Delete a file by its ID from a specific bucket (database or local disk). Only organization members can delete files.
  **Params:**
    - `organisationId` (string, URL param)
    - `type` ("db" | "local", URL param)
    - `bucket` (string, URL param)
    - `id` (string, URL param)
  **Response:**
    - Returns HTTP 204 No Content on success.

---

## Permissions & Scopes

- All file endpoints require a valid JWT and appropriate permissions.
- Uploading files (`POST`) requires the user to be an organization admin and have the `files:write` scope.
- Downloading, getting info, and deleting files require the user to be an organization member and have the `files:read` or `files:write` scope as appropriate.

---

## Configuration

- **Storage Type:** Files can be stored either in the database (`type=db`) or on the local disk (`type=local`).
- **Buckets:** Buckets are logical groupings for files (e.g., per chat, workspace, or general purpose).
- **Metadata:** Additional metadata such as `chatId` and `workspaceId` can be attached to files during upload.
- **Database:** File metadata and (optionally) file contents are stored in the connected database. Initialization happens automatically.

---

## Example Usage

### Upload a File

`POST /api/v1/organisation/0000-000-0000/files/db/general`

Form-data:
- file: (binary file)
- chatId: (optional)
- workspaceId: (optional)

### Get a File

`GET /api/v1/organisation/0000-000-0000/files/db/general/myfile.pdf`

### Get File Info

`GET /api/v1/organisation/0000-000-0000/files/db/general/abc123/info`

### Delete a File

`DELETE /api/v1/organisation/0000-000-0000/files/db/general/abc123`
