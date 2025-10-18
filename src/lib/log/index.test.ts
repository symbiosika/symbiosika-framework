import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import Logger from ".";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Create individual mocks
const mockMkdir = mock(() => Promise.resolve());
const mockStat = mock(() => Promise.resolve({ size: 0 }));
const mockAppendFile = mock(() => Promise.resolve());
const mockRename = mock(() => Promise.resolve());

// Mock fs/promises
mock.module("fs/promises", () => ({
  mkdir: mockMkdir,
  stat: mockStat,
  appendFile: mockAppendFile,
  rename: mockRename,
}));

// Mock console.log
const originalConsoleLog = console.log;
let consoleOutput: string[] = [];

describe("Logger", () => {
  beforeEach(() => {
    // Reset console output capture
    consoleOutput = [];
    console.log = (message: string) => {
      console.warn(message);
      consoleOutput.push(message);
    };
    // Reset environment
    process.env.WRITE_DEBUG_FILES = "true";
  });

  afterEach(() => {
    // Restore console.log
    console.log = originalConsoleLog;
  });

  it("should log info messages", async () => {
    await Logger.info("Test info message");
    expect(consoleOutput[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}.*\] \[INFO\] Test info message$/
    );
  });

  it("should log error messages", async () => {
    await Logger.error("Test error message");
    expect(consoleOutput[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}.*\] \[ERROR\] Test error message$/
    );
  });

  it("should log debug messages with objects", async () => {
    const testObj = { test: "value" };
    await Logger.debug(testObj);
    expect(consoleOutput[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}.*\] \[DEBUG\] {"test":"value"}$/
    );
  });

  it("should log chat messages", async () => {
    const chatMessages: ChatCompletionMessageParam[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    await Logger.logAChat("test-chat-id", ...chatMessages);
    console.log(consoleOutput[0]);
    expect(consoleOutput[0]).toContain(
      '[test-chat-id] {"role":"user","content":"Hello"}'
    );
  });

  it("should not write to file when WRITE_DEBUG_FILES is false", async () => {
    process.env.WRITE_DEBUG_FILES = "false";
    await Logger.info("Test message");
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  // it("should handle file rotation when size exceeds limit", async () => {
  //   // Reset mocks to ensure clean state
  //   mockMkdir.mockClear();
  //   mockStat.mockClear();
  //   mockAppendFile.mockClear();
  //   mockRename.mockClear();

  //   // Mock a large file size
  //   mockStat.mockImplementation(() => {
  //     console.warn("Mocking file size");
  //     return Promise.resolve({ size: 5 * 1024 * 1024 });
  //   });

  //   // Ensure WRITE_DEBUG_FILES is enabled
  //   process.env.WRITE_DEBUG_FILES = "true";

  //   await Logger.error("Test message");

  //   // Verify the rotation occurred
  //   // expect(mockRename).toHaveBeenCalledTimes(1);
  //   // expect(mockRename).toHaveBeenCalledWith(
  //   //   expect.stringContaining("logs/app.log"),
  //   //   expect.stringContaining("logs/app.")
  //   // );

  //   // Reset the stat mock for other tests
  //   // mockStat.mockImplementation(() => Promise.resolve({ size: 0 }));
  // });
});
