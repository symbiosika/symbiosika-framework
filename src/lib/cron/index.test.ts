import { test, expect } from "bun:test";
import scheduler from ".";

test("Scheduler", async () => {
  // Get next minute
  let taskExecuted = false;

  // Register a test task
  scheduler.registerTask("test-task", "* * * * * *", async () => {
    // console.log("test-task runs");
    taskExecuted = true;
    scheduler.stopTask("test-task"); // Cleanup after execution
  });

  // Wait for the task to execute
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(taskExecuted).toBe(true);

  // Set timeout to fail test if task doesn't execute within 70 seconds
  if (!taskExecuted) {
    scheduler.stopTask("test-task");
  }
}, 20000);
