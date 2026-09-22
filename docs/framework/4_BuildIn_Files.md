# Built-in File Management

## Overview

The symbiosika-framework provides a built-in file management system for organizations. These endpoints allow you to upload, retrieve, get info, and delete files in the database, on the local disk, or in an S3-compatible object store. All routes are protected by JWT authentication and permission checks.

---

## API Route Prefix

All file management API routes are prefixed with `/api/v1/` by default. For example, uploading a file is available at `/api/v1/tenant/:tenantId/files/:type/:bucket`.

---

## File Endpoints

The following endpoints are available for managing files within an organization:

- **POST `/api/v1/tenant/:tenantId/files/:type/:bucket`**  
  Upload a file to a specific bucket: to the database (`type=db`), the local disk (`type=local`) or an object store (`type=s3`). Only organization admins can upload files.
  **Params:**
    - `tenantId` (string, URL param)
    - `type` ("db" | "local" | "s3", URL param)
    - `bucket` (string, URL param)
  **Body:**
  Multipart form-data with at least a `file` field. Optionally, you can include `chatId` and `workspaceId` fields.
  **Response:**
  ```json
  {
    "path": "string",
    "id": "string",
    "name": "string",
    "tenantId": "string"
  }
  ```

- **GET `/api/v1/tenant/:tenantId/files/:type/:bucket/:filename`**  
  Retrieve a file by filename from a specific bucket. Only organization members can access files.
  **Params:**
    - `tenantId` (string, URL param)
    - `type` ("db" | "local" | "s3", URL param)
    - `bucket` (string, URL param)
    - `filename` (string, URL param)
  **Response:**
    - Returns the file as a binary response with the correct `Content-Type` header.

- **GET `/api/v1/tenant/:tenantId/files/:type/:bucket/:id/info`**  
  Get metadata/info about a file by its ID. Only for files stored in the database: `local` and `s3` keep no metadata row. Only organization members can access file info.
  **Params:**
    - `tenantId` (string, URL param)
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
    "tenantId": "string",
    "bucket": "string",
    "chatId": "string | null",
    "workspaceId": "string | null",
    "expiresAt": "string | null"
  }
  ```

- **DELETE `/api/v1/tenant/:tenantId/files/:type/:bucket/:id`**  
  Delete a file by its ID from a specific bucket. Only organization members can delete files.
  **Params:**
    - `tenantId` (string, URL param)
    - `type` ("db" | "local" | "s3", URL param)
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

### Storage backends

Files are stored by one of three backends. The backend is chosen per call (the
`:type` of the routes above, or the `storageType` argument of `saveFile`,
`getFile` and `deleteFile` in `lib/storage`), so one installation can use
several at once.

| type | where | when |
|---|---|---|
| `db` | the `base_files` table | nothing to set up, the bytes are in the backup of the database, and the metadata routes work |
| `local` | `static/upload` in the working directory | a single container with a persistent disc; a second replica does not see the files |
| `s3` | an S3-compatible object store | large data outside the database, reachable from every replica |

All three take the same arguments and hand back the same `{ path, id, name,
tenantId }`, so an app that wants to move its data from one to another only
changes which type it asks for. A file stays where it was written: nothing
migrates the bytes.

### S3

Any S3-compatible service works: AWS, MinIO, Ceph, Cloudflare R2, Hetzner,
Scaleway. Built on Bun's own S3 client, so nothing is added to the
dependencies.

| variable | meaning |
|---|---|
| `S3_BUCKET` | required: the bucket everything is stored in |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | credentials; may be left out when the runtime provides them (an instance role, a mounted credentials file, the `AWS_*` variables) |
| `S3_REGION` | the region of the bucket |
| `S3_ENDPOINT` | only for a service that is not AWS, e.g. `http://minio:9000` |
| `S3_PREFIX` | every key starts with it, so one bucket can hold several installations |
| `S3_VIRTUAL_HOSTED_STYLE` | `true` puts the bucket in the host name; the default is the path style MinIO and Ceph want |

Object keys are `<S3_PREFIX><tenantId>/<bucket>/<name>`, so the tenant is part
of the key: a caller never supplies that part and the file of one tenant cannot
be addressed from another. `assertS3Configured()` from `lib/storage/s3` checks
the configuration without touching the network; call it at start-up so a
missing bucket is heard on the first boot and not on the first upload.

The content type of a file read from S3 comes from the extension in its key
(the upload puts it there), not from a second request to the store.

### Sharing a file: a temporary URL

Something that is not the app sometimes needs the bytes: an analysis service, a
worker, a browser that should pull a large file without the request going
through the API. None of them has a session. `shareFile` from
`lib/storage/share` hands out a URL that carries its own permission and stops
working when the time is up.

```ts
import { shareFile } from "@framework/lib/storage/share";

const { url, expiresAt } = await shareFile(name, bucket, tenantId, storageType, {
  expiresInSeconds: 30 * 60,
});
```

It works for every backend, so a caller does not have to know where the file
lies:

| type | what the URL is |
|---|---|
| `s3` | a presigned URL of the object store. The bytes go straight from the store to whoever holds the link and never through this server |
| `db`, `local` | `<baseUrl><basePath>/files/shared/<token>`, served by this server |

The token for `db` and `local` is a JWT with a `purpose` of its own
(`file_share`). It names one tenant, one bucket, one file name and one backend,
and nothing else in the installation can be read with it. A session token
cannot be used on the share route and a share token cannot be used as a
session.

Time is the only thing the caller decides, and it is bounded: the default is
15 minutes and the ceiling is 24 hours, whatever is asked for. A link that
outlives a working day is not a share.

**GET `<basePath>/files/shared/:token`** takes no session: the token is the
permission. An invalid, forged or expired token is answered with 403 and the
same message in every case, so nothing is given away; a token whose file is
gone is a 404.

### Other

- **Buckets:** Buckets are logical groupings for files (e.g., per chat, workspace, or general purpose). With `s3` a bucket is one level of the object key, not a bucket of the store.
- **Metadata:** Additional metadata such as `chatId` and `workspaceId` can be attached to files during upload. Only the `db` backend keeps them.
- **Database:** File metadata and (optionally) file contents are stored in the connected database. Initialization happens automatically.

## Example Usage

### Upload a File

`POST /api/v1/tenant/0000-000-0000/files/db/general`

Form-data:
- file: (binary file)
- chatId: (optional)
- workspaceId: (optional)

### Get a File

`GET /api/v1/tenant/0000-000-0000/files/db/general/myfile.pdf`

### Get File Info

`GET /api/v1/tenant/0000-000-0000/files/db/general/abc123/info`

### Delete a File

`DELETE /api/v1/tenant/0000-000-0000/files/db/general/abc123`
