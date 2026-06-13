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
   - Query for pending jobs
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
