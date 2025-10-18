import { CronJob } from "cron";
import log from "../log";

export interface Task {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
}

class Scheduler {
  private tasks: Map<string, CronJob> = new Map();

  private log(message: string): void {
    log.logCustom({ name: "CronService" }, `Log: ${message}`);
  }

  private error(message: string): void {
    log.logCustom({ name: "CronService" }, `Error: ${message}`);
  }

  registerTask(name: string, schedule: string, handler: () => Promise<void>) {
    if (this.tasks.has(name)) {
      this.error(`Task with name "${name}" already exists`);
      throw new Error(`Task with name "${name}" already exists`);
    }

    const job = new CronJob(schedule, async () => {
      try {
        this.log(`Executing task "${name}"`);
        await handler();
      } catch (error) {
        this.error(`Error executing task "${name}": ${error}`);
      }
    });
    this.tasks.set(name, job);
    job.start();

    this.log(`Task "${name}" registered and started`);
  }

  stopTask(name: string) {
    const job = this.tasks.get(name);
    if (job) {
      job.stop();
      this.tasks.delete(name);
      this.log(`Task "${name}" stopped and removed`);
    } else {
      this.error(`Task "${name}" not found`);
    }
  }

  stopAllTasks() {
    for (const [name, job] of this.tasks) {
      job.stop();
      this.log(`Task "${name}" stopped`);
    }
    this.tasks.clear();
  }
}

const scheduler = new Scheduler();
export default scheduler;
