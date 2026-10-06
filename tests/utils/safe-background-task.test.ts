import { describe, expect, it, vi } from "vitest";
import { safeBackgroundTask } from "../../src/utils/safe-background-task.js";
import { logger } from "../../src/utils/logger.js";

const error = {
  name: "APIError",
  data: { statusCode: 429, isRetryable: true, message: "synthetic-private-prompt" },
};
const metadata = { name: "APIError", statusCode: 429, isRetryable: true };

describe("safeBackgroundTask error privacy", () => {
  it.each(["sync", "async"])(
    "sanitizes %s error-hook failures without replacing the original error",
    async (mode) => {
      const log = vi.spyOn(logger, "error").mockImplementation(() => {});
      const onError = vi.fn(() => {
        if (mode === "sync") throw error;
        return Promise.reject(error);
      });
      safeBackgroundTask({ taskName: "private-test", task: () => Promise.reject(error), onError });
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          "[safeBackgroundTask] private-test: onError failed:",
          metadata,
        ),
      );
      expect(onError).toHaveBeenCalledWith(error);
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-");
    },
  );

  it.each(["sync", "async"])(
    "preserves the original %s error for the callback, not the log",
    async (mode) => {
      const log = vi.spyOn(logger, "error").mockImplementation(() => {});
      const onError = vi.fn();
      safeBackgroundTask({
        taskName: "private-test",
        task: () => {
          if (mode === "sync") throw error;
          return Promise.reject(error);
        },
        onError,
      });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
      expect(log).toHaveBeenCalledWith("[safeBackgroundTask] private-test failed:", metadata);
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-");
    },
  );

  it.each(["sync", "async"])("sanitizes %s success-hook failures", async (mode) => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    safeBackgroundTask({
      taskName: "private-test",
      task: () => Promise.resolve("result"),
      onSuccess: () => {
        if (mode === "sync") throw error;
        return Promise.reject(error);
      },
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith(
      "[safeBackgroundTask] private-test: onSuccess failed:",
      metadata,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-");
  });
});
