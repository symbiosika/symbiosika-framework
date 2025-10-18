import { eq, and, desc } from "drizzle-orm";
import { jobs, type Job, type JobStatus } from "../db/schema/jobs";
import { getDb } from "../db/db-connection";
import log from "../log";

const CHECK_CYCLE_MS = 5000;

interface JobHandler {
  execute: (metadata: any, job: Job) => Promise<any>;
  onError?: (error: Error) => Promise<any>;
  onCancel?: (job: Job) => Promise<any>;
}

export interface JobHandlerRegister {
  type: string;
  handler: JobHandler;
}

const jobHandlers: Record<string, JobHandler> = {};

export function defineJob(type: string, handler: JobHandler) {
  jobHandlers[type] = handler;
}

async function processJob(job: Job) {
  await log.debug(`Executing job: ${job.id} from type ${job.type}`);

  const executor = jobHandlers[job.type];
  if (!executor) {
    try {
      await log.error(
        `No executor found for job type: ${job.type} and id: ${job.id}`
      );
      await getDb()
        .update(jobs)
        .set({
          status: "failed",
          error: { message: `No executor found for job type: ${job.type}` },
        })
        .where(eq(jobs.id, job.id));
    } catch (error) {
      log.error(`Error updating jobId ${job.id} status: ${error}`);
    }
    throw new Error(`No executor found for job type: ${job.type}`);
  }

  // update the job status to running
  await getDb()
    .update(jobs)
    .set({ status: "running" })
    .where(eq(jobs.id, job.id));

  try {
    const result = await executor.execute(job.metadata, job);
    log.debug(
      `Job ${job.id} from type ${job.type} completed ${result != null ? "with result" : "without result"}`
    );
    // complete the job
    await getDb()
      .update(jobs)
      .set({ status: "completed", result })
      .where(eq(jobs.id, job.id));
  } catch (e) {
    // if there is an error, we need to update the job status to failed
    if (executor.onError) {
      await executor.onError(e as Error);
    } else {
      log.error(`Error executing job: ${job.id} from type ${job.type}: ${e}`);
      getDb()
        .update(jobs)
        .set({ status: "failed", error: { message: (e as Error).message } })
        .where(eq(jobs.id, job.id));
    }
  }
}

export async function startJobQueue() {
  setInterval(async () => {
    // log.debug("Checking for pending jobs");
    const pendingJobs = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.status, "pending"));

    for (const job of pendingJobs) {
      await processJob(job);
    }
  }, CHECK_CYCLE_MS);
}

export async function getJob(id: string) {
  const res = await getDb().select().from(jobs).where(eq(jobs.id, id));
  if (res.length === 0) {
    throw new Error(`Job with id ${id} not found`);
  }
  return res[0];
}

export async function getJobsByOrganisation(organisationId: string, options?: {
  status?: JobStatus;
  type?: string;
  limit?: number;
  offset?: number;
}) {
  const db = getDb();
  const conditions = [eq(jobs.organisationId, organisationId)];
  
  if (options?.status) {
    conditions.push(eq(jobs.status, options.status));
  }
  
  if (options?.type) {
    conditions.push(eq(jobs.type, options.type));
  }
  
  // Create base query with conditions
  let query = db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt));
  
  // Apply pagination if provided
  if (options?.limit) {
    const limitValue = options.limit;
    
    if (options?.offset) {
      const offsetValue = options.offset;
      return await db
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt))
        .limit(limitValue)
        .offset(offsetValue);
    } else {
      return await db
        .select()
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt))
        .limit(limitValue);
    }
  }
  
  return await query;
}

export async function createJob(
  type: string,
  metadata: any,
  organisationId: string
) {
  const res = await getDb()
    .insert(jobs)
    .values({ type, metadata, status: "pending", organisationId })
    .returning();
  return res[0];
}

export async function updateJobProgress(
  id: string,
  progress: number
) {
  const job = await getJob(id);
  
  // Update the metadata with progress
  const metadata = {
    ...(job.metadata || {}),
    progress: progress
  };
  
  await getDb()
    .update(jobs)
    .set({ metadata })
    .where(eq(jobs.id, id));
    
  return await getJob(id);
}

export async function cancelJob(id: string) {
  const job = await getJob(id);
  
  // Only pending or running jobs can be cancelled
  if (job.status !== "pending" && job.status !== "running") {
    throw new Error("Only pending or running jobs can be cancelled");
  }
  
  // Call the onCancel handler if it exists
  const handler = jobHandlers[job.type];
  if (handler && handler.onCancel) {
    await handler.onCancel(job);
  }
  
  // Update job status to failed with cancellation message
  await getDb()
    .update(jobs)
    .set({
      status: "failed",
      error: { message: "Job cancelled by user" },
    })
    .where(eq(jobs.id, id));
    
  return await getJob(id);
}

/*
..in index.ts use "startJobQueue" to register the job queue
import { startJobQueue } from "../lib/jobs";
startJobQueue();

// to register new job handlers:
import { defineJob } from "../lib/jobQueue";

defineJob("render-video", {
  async execute(metadata: any) {    
    // Simulate a long-running task
    await new Promise(resolve => setTimeout(resolve, 10000));
    return { test: true };
  }
});
*/