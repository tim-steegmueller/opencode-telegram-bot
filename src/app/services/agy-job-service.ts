import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Bot, Context } from "grammy";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import type { ModelInfo } from "../types/model.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { chunkTelegramRenderedBlocks } from "../../bot/render/chunker.js";
import {
  resolveAgyCliPath,
  resolveCursorAgentPath,
  resolveTmuxPath,
} from "../../runtime/executable-paths.js";

const JOB_POLL_INTERVAL_MS = 1_000;
const UNIT_INACTIVE_GRACE_POLLS = 3;
const MAX_ACTIVITY_LINES = 8;

export interface AgyJobNotification {
  chatId: number;
  progressMessageId: number;
}

export interface DurableAgyJobOptions {
  prompt: string;
  projectDirectory: string;
  model?: ModelInfo;
  modelName: string;
  attachments?: FilePartInput[];
  accountHome?: string;
  timeoutMs: number;
  notification?: AgyJobNotification;
  onProgress?: (line: string) => void;
  backend?: AgentJobBackend;
  agentName?: string;
}

export interface DurableAgyJobResult {
  jobId: string;
  output: string;
  modelName: string;
}

export interface AgyJobWorkerRequest {
  jobId: string;
  prompt: string;
  projectDirectory: string;
  model?: ModelInfo;
  attachments: FilePartInput[];
  accountHome?: string;
  timeoutMs: number;
  backend?: AgentJobBackend;
}

type AgyJobStatus = "starting" | "running" | "completed" | "failed" | "aborted";
export type DurableAgyWorkerMode = "systemd" | "tmux";
export type AgentJobBackend = "agy" | "cursor";

export interface AgyJobRecord {
  version: 1;
  jobId: string;
  unitName: string;
  workerMode?: DurableAgyWorkerMode;
  backend?: AgentJobBackend;
  agentName?: string;
  status: AgyJobStatus;
  startedAt: string;
  completedAt?: string;
  modelName: string;
  projectDirectory: string;
  notification?: AgyJobNotification;
  activityLines: string[];
  output?: string;
  error?: string;
  notifiedAt?: string;
}

export class DurableAgyJobError extends Error {
  readonly jobId: string;

  constructor(jobId: string, message: string) {
    super(message);
    this.name = "DurableAgyJobError";
    this.jobId = jobId;
  }
}

export class DurableAgyJobAbortedError extends DurableAgyJobError {
  constructor(jobId: string) {
    super(jobId, "AGY job was aborted by the user");
    this.name = "DurableAgyJobAbortedError";
  }
}

const recoveredJobIds = new Set<string>();
let activeDurableJobId: string | null = null;

function getJobsDirectory(): string {
  return (
    process.env.AGY_JOBS_DIR?.trim() ||
    path.join(os.homedir(), ".local", "state", "telegram-agent", "jobs")
  );
}

function getRecordPath(jobId: string): string {
  return path.join(getJobsDirectory(), `${jobId}.json`);
}

function getRequestPath(jobId: string): string {
  return path.join(getJobsDirectory(), `${jobId}.request.json`);
}

async function ensureJobsDirectory(): Promise<void> {
  const directory = getJobsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
}

export async function readAgyJobRecord(jobId: string): Promise<AgyJobRecord> {
  return JSON.parse(await readFile(getRecordPath(jobId), "utf8")) as AgyJobRecord;
}

export async function writeAgyJobRecord(record: AgyJobRecord): Promise<void> {
  await ensureJobsDirectory();
  await writePrivateJson(getRecordPath(record.jobId), record);
}

export async function readAndRemoveAgyJobRequest(
  requestPath: string,
): Promise<AgyJobWorkerRequest> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as AgyJobWorkerRequest;
  await rm(requestPath, { force: true });
  return request;
}

function runCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();
      if (code !== 0) {
        reject(
          new Error(
            `${path.basename(file)} exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderrText.trim()}`,
          ),
        );
        return;
      }

      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

async function launchSystemdJob(record: AgyJobRecord, requestPath: string): Promise<void> {
  const systemdRunPath = process.env.SYSTEMD_RUN_PATH?.trim() || "/usr/bin/systemd-run";
  const workerPath = fileURLToPath(new URL("./agy-job-worker.js", import.meta.url));

  await runCommand(systemdRunPath, [
    "--user",
    `--unit=${record.unitName}`,
    "--collect",
    "--property=KillMode=mixed",
    "--property=TimeoutStopSec=30",
    `--setenv=PATH=${process.env.PATH ?? ""}`,
    `--setenv=AGY_JOBS_DIR=${getJobsDirectory()}`,
    `--setenv=AGY_CLI_PATH=${resolveAgyCliPath()}`,
    `--setenv=CURSOR_AGENT_PATH=${resolveCursorAgentPath()}`,
    process.execPath,
    workerPath,
    requestPath,
  ]);
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function launchTmuxJob(record: AgyJobRecord, requestPath: string): Promise<void> {
  const workerPath = fileURLToPath(new URL("./agy-job-worker.js", import.meta.url));
  const workerCommand = [process.execPath, workerPath, requestPath]
    .map(quoteShellArgument)
    .join(" ");

  await runCommand(resolveTmuxPath(), [
    "new-session",
    "-d",
    "-s",
    record.unitName,
    "-e",
    `PATH=${process.env.PATH ?? ""}`,
    "-e",
    `AGY_JOBS_DIR=${getJobsDirectory()}`,
    "-e",
    `AGY_CLI_PATH=${resolveAgyCliPath()}`,
    "-e",
    `CURSOR_AGENT_PATH=${resolveCursorAgentPath()}`,
    workerCommand,
  ]);
}

function resolveWorkerMode(): DurableAgyWorkerMode {
  return process.env.AGY_WORKER_MODE?.trim() === "tmux" ? "tmux" : "systemd";
}

async function launchWorker(record: AgyJobRecord, requestPath: string): Promise<void> {
  if (record.workerMode === "tmux") {
    await launchTmuxJob(record, requestPath);
    return;
  }

  await launchSystemdJob(record, requestPath);
}

async function isUnitActive(unitName: string): Promise<boolean> {
  const systemctlPath = process.env.SYSTEMCTL_PATH?.trim() || "/usr/bin/systemctl";
  try {
    const { stdout } = await runCommand(systemctlPath, ["--user", "is-active", unitName]);
    return ["active", "activating", "deactivating"].includes(stdout.trim());
  } catch {
    return false;
  }
}

async function isWorkerActive(record: AgyJobRecord): Promise<boolean> {
  if (record.workerMode === "tmux") {
    try {
      await runCommand(resolveTmuxPath(), ["has-session", "-t", `=${record.unitName}`]);
      return true;
    } catch {
      return false;
    }
  }

  return isUnitActive(record.unitName);
}

async function stopWorker(record: AgyJobRecord): Promise<void> {
  if (record.workerMode === "tmux") {
    await runCommand(resolveTmuxPath(), ["kill-session", "-t", `=${record.unitName}`]);
    return;
  }

  const systemctlPath = process.env.SYSTEMCTL_PATH?.trim() || "/usr/bin/systemctl";
  await runCommand(systemctlPath, ["--user", "stop", record.unitName]);
}

async function markJobFailed(record: AgyJobRecord, error: unknown): Promise<AgyJobRecord> {
  const failedRecord: AgyJobRecord = {
    ...record,
    status: "failed",
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
  await writeAgyJobRecord(failedRecord);
  return failedRecord;
}

async function waitForAgyJob(
  jobId: string,
  onProgress?: (line: string) => void,
): Promise<DurableAgyJobResult> {
  const seenActivity = new Set<string>();
  let inactivePolls = 0;

  while (true) {
    const record = await readAgyJobRecord(jobId);
    for (const line of record.activityLines) {
      if (!seenActivity.has(line)) {
        seenActivity.add(line);
        onProgress?.(line);
      }
    }

    if (record.status === "completed") {
      return {
        jobId,
        output: record.output || "(AGY finished without output.)",
        modelName: record.modelName,
      };
    }

    if (record.status === "failed") {
      throw new DurableAgyJobError(jobId, record.error || "AGY worker failed");
    }

    if (record.status === "aborted") {
      throw new DurableAgyJobAbortedError(jobId);
    }

    if (await isWorkerActive(record)) {
      inactivePolls = 0;
    } else {
      inactivePolls += 1;
      if (inactivePolls >= UNIT_INACTIVE_GRACE_POLLS) {
        await rm(getRequestPath(jobId), { force: true });
        const failedRecord = await markJobFailed(
          record,
          new Error(`AGY worker ${record.unitName} stopped without a result`),
        );
        throw new DurableAgyJobError(jobId, failedRecord.error || "AGY worker stopped");
      }
    }

    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }
}

export async function runDurableAgyJob(
  options: DurableAgyJobOptions,
): Promise<DurableAgyJobResult> {
  await ensureJobsDirectory();
  const jobId = randomUUID();
  const unitName = `tg-agy-${jobId.replaceAll("-", "")}`;
  const workerMode = resolveWorkerMode();
  const record: AgyJobRecord = {
    version: 1,
    jobId,
    unitName,
    workerMode,
    backend: options.backend ?? "agy",
    agentName: options.agentName ?? "AGY",
    status: "starting",
    startedAt: new Date().toISOString(),
    modelName: options.modelName,
    projectDirectory: options.projectDirectory,
    notification: options.notification,
    activityLines: [],
  };
  const request: AgyJobWorkerRequest = {
    jobId,
    prompt: options.prompt,
    projectDirectory: options.projectDirectory,
    model: options.model,
    attachments: options.attachments ?? [],
    accountHome: options.accountHome,
    timeoutMs: options.timeoutMs,
    backend: options.backend ?? "agy",
  };
  const requestPath = getRequestPath(jobId);

  await writeAgyJobRecord(record);
  await writePrivateJson(requestPath, request);
  activeDurableJobId = jobId;

  try {
    await launchWorker(record, requestPath);
  } catch (error) {
    await rm(requestPath, { force: true });
    await markJobFailed(record, error);
    if (activeDurableJobId === jobId) {
      activeDurableJobId = null;
    }
    throw new DurableAgyJobError(jobId, error instanceof Error ? error.message : String(error));
  }

  logger.info(`[AGY] Durable worker launched job=${jobId} mode=${workerMode} unit=${unitName}`);
  try {
    return await waitForAgyJob(jobId, options.onProgress);
  } finally {
    if (activeDurableJobId === jobId) {
      activeDurableJobId = null;
    }
  }
}

export async function runDurableCursorJob(
  options: Omit<DurableAgyJobOptions, "backend" | "agentName">,
): Promise<DurableAgyJobResult> {
  return runDurableAgyJob({ ...options, backend: "cursor", agentName: "Cursor" });
}

export async function abortActiveAgyJob(): Promise<boolean> {
  const jobId = activeDurableJobId ?? recoveredJobIds.values().next().value;
  if (!jobId) {
    return false;
  }

  const record = await readAgyJobRecord(jobId);
  if (record.status === "completed" || record.status === "failed" || record.status === "aborted") {
    return false;
  }

  await stopWorker(record);
  const latestRecord = await readAgyJobRecord(jobId);
  if (latestRecord.status === "completed" || latestRecord.status === "failed") {
    return false;
  }

  await writeAgyJobRecord({
    ...latestRecord,
    status: "aborted",
    completedAt: new Date().toISOString(),
    error: "AGY job was aborted by the user",
  });
  logger.info(`[AGY] Durable worker aborted job=${jobId} unit=${record.unitName}`);
  return true;
}

export async function markAgyJobNotified(jobId: string): Promise<void> {
  const record = await readAgyJobRecord(jobId);
  await writeAgyJobRecord({
    ...record,
    activityLines: [],
    output: undefined,
    error: undefined,
    notifiedAt: new Date().toISOString(),
  });
}

export async function sendAgyResult(
  bot: Bot<Context>,
  chatId: number,
  modelName: string,
  output: string,
): Promise<void> {
  const message = t("agy.response", { model: modelName, output });
  const parts = chunkTelegramRenderedBlocks(
    [
      {
        blockType: "plain",
        mode: "plain",
        text: message,
        fallbackText: message,
        source: "plain",
      },
    ],
    { maxPartLength: 4096 },
  );
  for (const part of parts) {
    await bot.api.sendMessage(chatId, part.text);
  }
}

export async function sendAgentResult(
  bot: Bot<Context>,
  chatId: number,
  agentName: string,
  modelName: string,
  output: string,
): Promise<void> {
  const message = `${agentName} (${modelName}) finished:\n\n${output}`;
  const parts = chunkTelegramRenderedBlocks(
    [
      {
        blockType: "plain",
        mode: "plain",
        text: message,
        fallbackText: message,
        source: "plain",
      },
    ],
    { maxPartLength: 4096 },
  );
  for (const part of parts) {
    await bot.api.sendMessage(chatId, part.text);
  }
}

function renderRecoveredProgress(record: AgyJobRecord): string {
  const seconds = Math.max(
    1,
    Math.round((Date.now() - new Date(record.startedAt).getTime()) / 1_000),
  );
  const activity = record.activityLines.slice(-MAX_ACTIVITY_LINES);
  const base = t("agy.running", { model: record.modelName, seconds });
  return activity.length > 0
    ? `${base}\n\n${activity.map((line) => `• ${line}`).join("\n")}`
    : base;
}

async function notifyRecoveredJob(bot: Bot<Context>, record: AgyJobRecord): Promise<void> {
  if (!record.notification || record.notifiedAt) {
    return;
  }

  const { chatId, progressMessageId } = record.notification;
  if (record.status === "completed") {
    await bot.api
      .editMessageText(chatId, progressMessageId, t("agy.finished_status"))
      .catch((error) => logger.debug("[AGY] Failed to finalize recovered progress message", error));
    const output = record.output || `(${record.agentName ?? "AGY"} finished without output.)`;
    if (record.backend === "cursor") {
      await sendAgentResult(bot, chatId, record.agentName ?? "Cursor", record.modelName, output);
    } else {
      await sendAgyResult(bot, chatId, record.modelName, output);
    }
    await markAgyJobNotified(record.jobId);
    return;
  }

  if (record.status === "failed") {
    await bot.api
      .editMessageText(chatId, progressMessageId, t("agy.failed_status"))
      .catch((error) => logger.debug("[AGY] Failed to mark recovered progress message", error));
    await bot.api.sendMessage(chatId, t("agy.error", { error: record.error || "Unknown error" }));
    await markAgyJobNotified(record.jobId);
    return;
  }

  if (record.status === "aborted") {
    await bot.api
      .editMessageText(chatId, progressMessageId, t("stop.success"))
      .catch((error) => logger.debug("[AGY] Failed to mark recovered aborted job", error));
    await markAgyJobNotified(record.jobId);
  }
}

async function resumeAgyJob(bot: Bot<Context>, record: AgyJobRecord): Promise<void> {
  recoveredJobIds.add(record.jobId);
  if (record.notification) {
    await bot.api
      .editMessageText(
        record.notification.chatId,
        record.notification.progressMessageId,
        renderRecoveredProgress(record),
      )
      .catch((error) => logger.debug("[AGY] Failed to resume progress message", error));
  }

  try {
    await waitForAgyJob(record.jobId, (line) => {
      logger.info(`[AGY] Recovered job progress job=${record.jobId}: ${line}`);
    });
  } catch (error) {
    logger.warn(`[AGY] Recovered job failed job=${record.jobId}`, error);
  } finally {
    recoveredJobIds.delete(record.jobId);
  }

  await notifyRecoveredJob(bot, await readAgyJobRecord(record.jobId));
}

export async function recoverAgyJobs(bot: Bot<Context>): Promise<void> {
  await ensureJobsDirectory();
  const filenames = await readdir(getJobsDirectory());
  const records = await Promise.all(
    filenames
      .filter((filename) => /^[0-9a-f-]+\.json$/.test(filename))
      .map(async (filename) => {
        try {
          return JSON.parse(
            await readFile(path.join(getJobsDirectory(), filename), "utf8"),
          ) as AgyJobRecord;
        } catch (error) {
          logger.warn(`[AGY] Could not read job record ${filename}`, error);
          return null;
        }
      }),
  );

  for (const record of records.filter((value): value is AgyJobRecord => value !== null)) {
    if (record.notifiedAt) {
      continue;
    }

    if (
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "aborted"
    ) {
      await notifyRecoveredJob(bot, record).catch((error) => {
        logger.warn(`[AGY] Failed to notify completed job=${record.jobId}`, error);
      });
      continue;
    }

    if (await isWorkerActive(record)) {
      logger.info(`[AGY] Reattaching durable job=${record.jobId} unit=${record.unitName}`);
      void resumeAgyJob(bot, record).catch((error) => {
        recoveredJobIds.delete(record.jobId);
        logger.error(`[AGY] Failed to resume durable job=${record.jobId}`, error);
      });
      continue;
    }

    await rm(getRequestPath(record.jobId), { force: true });
    const failedRecord = await markJobFailed(
      record,
      new Error(`AGY worker ${record.unitName} is no longer active`),
    );
    await notifyRecoveredJob(bot, failedRecord).catch((error) => {
      logger.warn(`[AGY] Failed to notify orphaned job=${record.jobId}`, error);
    });
  }
}

export function hasRecoveredAgyJob(): boolean {
  return recoveredJobIds.size > 0;
}
