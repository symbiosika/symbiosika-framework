# Job Service API

This file is generated automatically by a GitHub action. Do not edit manually.

## defineJob
Register a job handler.

```typescript
function defineJob(type: string, handler: JobHandler): any
```

## startJobQueue
Start the job queue polling loop.

```typescript
function startJobQueue(): Promise<any>
```

## getJob
Retrieve a job by id.

```typescript
function getJob(id: string): Promise<any>
```

## getJobsByOrganisation
List jobs for an organisation.

```typescript
function getJobsByOrganisation(organisationId: string, options?: {
  status?: JobStatus;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<any>
```

## createJob
Create a new job.

```typescript
function createJob(type: string, metadata: any, organisationId: string): Promise<any>
```

## updateJobProgress
Update progress information of a job.

```typescript
function updateJobProgress(id: string, progress: number): Promise<any>
```

## cancelJob
Cancel a pending or running job.

```typescript
function cancelJob(id: string): Promise<any>
```

## Interfaces

```typescript
export interface JobHandlerRegister {
  type: string;
  handler: JobHandler;
}
```

```typescript
interface JobHandler {
  execute: (metadata: any, job: Job) => Promise<any>;
  onError?: (error: Error) => Promise<any>;
  onCancel?: (job: Job) => Promise<any>;
}
```

```typescript
export type JobStatus = "pending" | "running" | "completed" | "failed";
```

```typescript
export type Job = typeof jobs.$inferSelect;
```

```typescript
export type NewJob = typeof jobs.$inferInsert;
```

