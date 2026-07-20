# Job Queue System

This document describes how to use and implement background jobs in the backend system.

## Overview

The job queue system allows you to execute long-running tasks asynchronously. Jobs are stored in the database and processed by a background worker that runs at regular intervals (every 5 seconds by default).

## Registering Job Handlers

Job handlers can be registered when initializing the server:

```typescript
const server = defineServer({
  // ... other config options ...
  jobHandlers: [
    {
      type: "myGreatNewJob",
      handler: {
        execute: async (metadata) => {
          // Your job logic here
          return result;
        },
        // Optional error handler
        onError: async (error) => {
          // Custom error handling
        },
      },
    },
  ],
});
```

### Job Handler Interface

```typescript
interface JobHandler {
  execute: (metadata: any) => Promise<any>;
  onError?: (error: Error) => Promise<any>;
}
```

## Creating Jobs

New Jobs for a registered JobType can be created using the API:

```http
POST /api/v1/collections/jobs
```

Request body:

```json
{
  "type": "myGreatNewJob",
  "metadata": {
    // Job-specific data
  }
}
```

### Scheduling / Delayed Execution (Queues)

By default a job is eligible for execution immediately. To use the job system
as a queue with delayed execution, provide an optional `scheduledAt` timestamp
(ISO 8601). The job will stay `pending` and will **not** be picked up by the
worker before that point in time:

```json
{
  "type": "myGreatNewJob",
  "metadata": {
    // Job-specific data
  },
  "scheduledAt": "2026-07-01T08:00:00.000Z"
}
```

When `scheduledAt` is omitted (or `null`), the job runs as soon as the worker's
next cycle picks it up. Due jobs are processed ordered by `scheduledAt`, then by
`createdAt`. `scheduledAt` only defines the *earliest* execution time — the
actual start depends on the worker cycle (every 5 seconds by default) and how
many other jobs are queued.

The same applies when creating jobs programmatically:

```typescript
import { createJob } from "./lib/jobs";

await createJob(
  "myGreatNewJob",
  { foo: "bar" },
  tenantId,
  "2026-07-01T08:00:00.000Z" // optional earliest execution time
);
```

## Notify the User on Completion (opt-in)

Instead of polling, a job can push a message into the owning user's
notification queue (`user_messages`, exposed via `GET /user/notifications`)
when it finishes. This is fully opt-in and generic — it works for any job type.

Set `notifyOnCompletion: true` in the job metadata, and make sure the job has
an owning `userId` (the `POST .../jobs` route and the knowledge ingestion
routes set this automatically from the token):

```json
{
  "type": "myGreatNewJob",
  "metadata": {
    "notifyOnCompletion": true,
    "notifySuccessMessage": "All done!",           // optional, custom text
    "notifyErrorMessage": "Something went wrong"    // optional, custom text
  }
}
```

When the job finishes, a message is inserted for `job.userId`:

- **success** → `messageType: "success"`, text = `notifySuccessMessage` or
  `Job completed: <type>`
- **failure** → `messageType: "error"`, text = `notifyErrorMessage` or
  `Job failed: <type> — <error>`

Every such message carries a structured `meta` payload so the UI can act on it
without parsing the text:

```json
{ "jobId": "<uuid>", "jobType": "myGreatNewJob", "status": "completed" }
```

Notes:
- Requires `job.userId`; without it the notification is skipped.
- Sending the notification never affects job processing — a failure to notify
  is logged and swallowed.
- The message shows up in the existing inbox (`GET /user/notifications`) and is
  acknowledged via `PATCH /user/notifications/:id/confirm`.

## Checking Job Status

Jobs can have the following statuses: `pending`, `running`, `completed`, or `failed`.

Get status of a specific job:

```http
GET /api/v1/collections/jobs/:id
```

List all jobs:

```http
GET /api/v1/collections/jobs
```

## Internal Architecture

1. Jobs are stored in the database with their type, metadata, status, and results
2. The job queue worker (`startJobQueue`) runs every 5 seconds to:
   - Query for pending jobs that are due (`scheduledAt` is null or in the past)
   - Update job status to "running"
   - Execute the corresponding handler
   - Update job status to "completed" (with results) or "failed" (with error)
   - Save the result in the Database if a result is given
3. If a job fails:
   - The custom `onError` handler is called if provided
   - Otherwise, the error is logged and the job is marked as failed

### Error Handling

- If no executor is found for a job type, the job is marked as failed
- Job execution errors are caught and stored in the database
- Custom error handling can be implemented via the `onError` handler
