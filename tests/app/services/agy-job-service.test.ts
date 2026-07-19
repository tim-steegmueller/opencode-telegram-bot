import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocked.spawnMock,
}));

function createChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("app/services/agy-job-service", () => {
  let jobsDirectory: string;

  beforeEach(async () => {
    mocked.spawnMock.mockReset();
    jobsDirectory = await mkdtemp(path.join(os.tmpdir(), "agy-job-service-test-"));
    process.env.AGY_JOBS_DIR = jobsDirectory;
    process.env.SYSTEMD_RUN_PATH = "/test/systemd-run";
    process.env.SYSTEMCTL_PATH = "/test/systemctl";
  });

  afterEach(async () => {
    delete process.env.AGY_JOBS_DIR;
    delete process.env.SYSTEMD_RUN_PATH;
    delete process.env.SYSTEMCTL_PATH;
    await rm(jobsDirectory, { recursive: true, force: true });
  });

  it("launches a private systemd worker job and keeps prompt secrets out of metadata", async () => {
    mocked.spawnMock.mockImplementation((file: string, args: string[]) => {
      const child = createChild();
      expect(file).toBe("/test/systemd-run");

      setTimeout(async () => {
        const requestPath = args.at(-1) as string;
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { jobId: string };
        const recordPath = path.join(jobsDirectory, `${request.jobId}.json`);
        const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
        await import("../../../src/app/services/agy-job-service.js").then(({ writeAgyJobRecord }) =>
          writeAgyJobRecord({
            ...record,
            status: "completed",
            completedAt: new Date().toISOString(),
            output: "worker result",
          }),
        );
        child.emit("close", 0, null);
      }, 0);

      return child;
    });

    const { runDurableAgyJob } = await import("../../../src/app/services/agy-job-service.js");
    const result = await runDurableAgyJob({
      prompt: "sensitive prompt",
      projectDirectory: "/tmp/project",
      modelName: "Claude Opus 4.6 (Thinking)",
      accountHome: "/tmp/private-account",
      timeoutMs: 60_000,
    });

    expect(result).toEqual({
      jobId: expect.any(String),
      output: "worker result",
      modelName: "Claude Opus 4.6 (Thinking)",
    });
    expect(mocked.spawnMock).toHaveBeenCalledWith(
      "/test/systemd-run",
      expect.arrayContaining([
        "--user",
        "--collect",
        "--property=KillMode=mixed",
        "--property=TimeoutStopSec=30",
      ]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const recordPath = path.join(jobsDirectory, `${result.jobId}.json`);
    const recordText = await readFile(recordPath, "utf8");
    expect(recordText).not.toContain("sensitive prompt");
    expect(recordText).not.toContain("private-account");
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect((await stat(jobsDirectory)).mode & 0o777).toBe(0o700);
  });

  it("delivers a completed unnotified job after gateway restart", async () => {
    const { markAgyJobNotified, readAgyJobRecord, recoverAgyJobs, writeAgyJobRecord } =
      await import("../../../src/app/services/agy-job-service.js");
    await writeAgyJobRecord({
      version: 1,
      jobId: "12345678-1234-1234-1234-123456789abc",
      unitName: "tg-agy-test",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      modelName: "Test model",
      projectDirectory: "/tmp/project",
      notification: { chatId: 777, progressMessageId: 99 },
      activityLines: [],
      output: "recovered result",
    });
    const bot = {
      api: {
        editMessageText: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as never;

    await recoverAgyJobs(bot);

    expect(bot.api.editMessageText).toHaveBeenCalledWith(777, 99, "✅ AGY agent finished.");
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      777,
      "AGY (Test model) finished:\n\nrecovered result",
    );
    expect((await readAgyJobRecord("12345678-1234-1234-1234-123456789abc")).notifiedAt).toEqual(
      expect.any(String),
    );

    await markAgyJobNotified("12345678-1234-1234-1234-123456789abc");
  });

  it("stops the active transient unit and records a user abort", async () => {
    mocked.spawnMock.mockImplementation((file: string, args: string[]) => {
      const child = createChild();
      setTimeout(() => {
        if (file === "/test/systemctl" && args.includes("is-active")) {
          child.stdout.emit("data", Buffer.from("active\n"));
        }
        child.emit("close", 0, null);
      }, 0);
      return child;
    });
    const {
      abortActiveAgyJob,
      DurableAgyJobAbortedError,
      readAgyJobRecord,
      runDurableAgyJob,
    } = await import("../../../src/app/services/agy-job-service.js");

    const runPromise = runDurableAgyJob({
      prompt: "long running task",
      projectDirectory: "/tmp/project",
      modelName: "Test model",
      timeoutMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(abortActiveAgyJob()).resolves.toBe(true);
    await expect(runPromise).rejects.toBeInstanceOf(DurableAgyJobAbortedError);

    const systemdArgs = mocked.spawnMock.mock.calls.find(
      ([file, args]) => file === "/test/systemd-run" && Array.isArray(args),
    )?.[1] as string[];
    const unitArg = systemdArgs.find((arg) => arg.startsWith("--unit="));
    const jobId = unitArg?.slice("--unit=tg-agy-".length);
    const records = await Promise.all(
      (await import("node:fs/promises").then(({ readdir }) => readdir(jobsDirectory)))
        .filter((filename) => /^[0-9a-f-]+\.json$/.test(filename))
        .map((filename) => readAgyJobRecord(filename.replace(/\.json$/, ""))),
    );
    expect(jobId).toBeTruthy();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("aborted");
    expect(mocked.spawnMock).toHaveBeenCalledWith(
      "/test/systemctl",
      ["--user", "stop", records[0]?.unitName],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("splits long AGY results into Telegram-sized messages", async () => {
    const { sendAgyResult } = await import("../../../src/app/services/agy-job-service.js");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bot = { api: { sendMessage } } as never;

    await sendAgyResult(bot, 777, "Test model", "x".repeat(5_000));

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const [, message] of sendMessage.mock.calls) {
      expect((message as string).length).toBeLessThanOrEqual(4096);
    }
  });
});
