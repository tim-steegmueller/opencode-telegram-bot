import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import type { ModelInfo } from "../types/model.js";
import { resolveCursorAgentPath } from "../../runtime/executable-paths.js";
import { logger } from "../../utils/logger.js";
import {
  hasRecoveredAgyJob,
  runDurableCursorJob,
  type AgyJobNotification,
} from "./agy-job-service.js";

const DEFAULT_CURSOR_MODEL = "auto";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export interface CursorAgentRunOptions {
  prompt: string;
  projectDirectory: string;
  model?: ModelInfo;
  attachments?: FilePartInput[];
  timeoutMs?: number;
  notification?: AgyJobNotification;
}

export interface CursorAgentRunResult {
  output: string;
  modelName: string;
  jobId?: string;
}

export interface CursorModelInfo extends ModelInfo {
  displayName: string;
}

let activeRun = false;

function resolveTimeoutMs(): number {
  const value = Number(process.env.CURSOR_AGENT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function resolveCursorModel(model?: ModelInfo): string {
  if (!model) {
    return DEFAULT_CURSOR_MODEL;
  }
  if (model.providerID !== "cursor") {
    throw new Error(
      `Cursor mode requires a cursor model, received ${model.providerID}/${model.modelID}`,
    );
  }
  return model.modelID;
}

function decodeDataUri(url: string): Buffer {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  if (!match?.[1]) {
    throw new Error("Cursor attachments must use base64 data URIs");
  }
  return Buffer.from(match[1], "base64");
}

async function prepareAttachments(attachments: FilePartInput[]): Promise<{
  directory: string;
  filePaths: string[];
} | null> {
  if (attachments.length === 0) {
    return null;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-cursor-"));
  try {
    const filePaths: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const filename = path.basename(attachment.filename || `attachment-${index + 1}`);
      const filePath = path.join(directory, `${index + 1}-${filename}`);
      await writeFile(filePath, decodeDataUri(attachment.url), { mode: 0o600 });
      filePaths.push(filePath);
    }
    return { directory, filePaths };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function buildPrompt(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) {
    return prompt;
  }
  const instruction = `Telegram attachments:\n${filePaths.map((file) => `- ${file}`).join("\n")}\nInspect these files as part of the request.`;
  return prompt.trim() ? `${prompt}\n\n${instruction}` : instruction;
}

function runCursorCommand(
  args: string[],
  options: { cwd?: string; timeoutMs: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const child = spawn(resolveCursorAgentPath(), args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Cursor Agent timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timeout.unref();

    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > options.maxBuffer && !settled) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(new Error(`Cursor Agent output exceeded ${options.maxBuffer} bytes`));
        return;
      }
      target.push(buffer);
    };

    child.stdout?.on("data", (chunk) => append(stdout, chunk));
    child.stderr?.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();
      if (code !== 0) {
        reject(
          new Error(
            `Cursor Agent exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderrText.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

export function isCursorAgentRunActive(): boolean {
  return activeRun || hasRecoveredAgyJob();
}

export async function listCursorModels(): Promise<CursorModelInfo[]> {
  const { stdout } = await runCursorCommand(["models"], {
    timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => /^(\S+)\s+-\s+(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      providerID: "cursor",
      modelID: match[1],
      displayName: match[2],
    }));
}

export async function searchCursorModels(query: string, limit = 10): Promise<CursorModelInfo[]> {
  const normalized = query.trim().toLowerCase();
  const models = await listCursorModels();
  return models
    .filter(
      (model) =>
        model.modelID.toLowerCase().includes(normalized) ||
        model.displayName.toLowerCase().includes(normalized),
    )
    .slice(0, limit);
}

export async function executeCursorAgentPrompt(
  options: CursorAgentRunOptions,
): Promise<CursorAgentRunResult> {
  let prepared: Awaited<ReturnType<typeof prepareAttachments>> = null;
  try {
    prepared = await prepareAttachments(options.attachments ?? []);
    const modelName = resolveCursorModel(options.model);
    const args = [
      "-p",
      "--output-format",
      "text",
      "--model",
      modelName,
      "--trust",
      "--yolo",
      "--workspace",
      options.projectDirectory,
    ];
    if (prepared) {
      args.push("--add-dir", prepared.directory);
    }
    args.push(buildPrompt(options.prompt, prepared?.filePaths ?? []));

    logger.info(
      `[Cursor] Starting agent run model="${modelName}" project=${options.projectDirectory} promptLength=${options.prompt.length}`,
    );
    const { stdout, stderr } = await runCursorCommand(args, {
      cwd: options.projectDirectory,
      timeoutMs: options.timeoutMs ?? resolveTimeoutMs(),
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return {
      output: stdout.trim() || stderr.trim() || "(Cursor finished without output.)",
      modelName,
    };
  } finally {
    if (prepared) {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  }
}

export async function runCursorAgentPrompt(
  options: CursorAgentRunOptions,
): Promise<CursorAgentRunResult> {
  if (isCursorAgentRunActive()) {
    throw new Error("Cursor Agent run already active");
  }

  activeRun = true;
  try {
    if (["systemd", "tmux"].includes(process.env.AGY_WORKER_MODE?.trim() ?? "")) {
      return await runDurableCursorJob({
        ...options,
        modelName: resolveCursorModel(options.model),
        timeoutMs: options.timeoutMs ?? resolveTimeoutMs(),
      });
    }
    return await executeCursorAgentPrompt(options);
  } finally {
    activeRun = false;
  }
}
