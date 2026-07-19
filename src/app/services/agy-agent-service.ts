import { spawn } from "node:child_process";
import { mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import type { ModelInfo } from "../types/model.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_AGY_PATH = "/home/tim/.local/bin/agy";
const DEFAULT_AGY_MODEL = "Gemini 3.5 Flash (High)";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const ACTIVITY_POLL_INTERVAL_MS = 2_500;
const ACTIVITY_FILE_LOOKBACK_MS = 5_000;
const ACTIVITY_MAX_FILE_BYTES = 768 * 1024;

const AGY_MODEL_NAMES: Record<string, string> = {
  "gemini-3.5-flash-high": "Gemini 3.5 Flash (High)",
  "gemini-3.5-flash-medium": "Gemini 3.5 Flash (Medium)",
  "gemini-3.5-flash-low": "Gemini 3.5 Flash (Low)",
  "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
  "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
  "claude-sonnet-4.6": "Claude Sonnet 4.6 (Thinking)",
  "claude-opus-4.6": "Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b": "GPT-OSS 120B (Medium)",
};

let activeRun = false;

export interface AgyAgentRunOptions {
  prompt: string;
  projectDirectory: string;
  model?: ModelInfo;
  attachments?: FilePartInput[];
  onProgress?: (line: string) => void;
}

export interface AgyAgentRunResult {
  output: string;
  modelName: string;
}

function resolveAgyPath(): string {
  return process.env.AGY_CLI_PATH?.trim() || DEFAULT_AGY_PATH;
}

function resolveTimeoutMs(): number {
  const value = Number(process.env.AGY_AGENT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

export function resolveAgyModelName(model?: ModelInfo): string {
  if (model?.providerID !== "antigravity") {
    return DEFAULT_AGY_MODEL;
  }

  return AGY_MODEL_NAMES[model.modelID] ?? DEFAULT_AGY_MODEL;
}

export function isAgyAgentRunActive(): boolean {
  return activeRun;
}

function decodeDataUri(url: string): Buffer {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  if (!match?.[1]) {
    throw new Error("AGY attachments must use base64 data URIs");
  }

  return Buffer.from(match[1], "base64");
}

async function prepareAgyAttachments(attachments: FilePartInput[]): Promise<{
  directory: string;
  filePaths: string[];
} | null> {
  if (attachments.length === 0) {
    return null;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-agy-"));

  try {
    const filePaths: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const filename = path.basename(attachment.filename || `attachment-${index + 1}`);
      const filePath = path.join(directory, `${index + 1}-${filename}`);
      await writeFile(filePath, decodeDataUri(attachment.url));
      filePaths.push(filePath);
    }

    return { directory, filePaths };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function buildAgyPrompt(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) {
    return prompt;
  }

  const attachmentList = filePaths.map((filePath) => `- ${filePath}`).join("\n");
  const attachmentInstruction = `Telegram attachments:\n${attachmentList}\nInspect these files as part of the request.`;
  return prompt.trim() ? `${prompt}\n\n${attachmentInstruction}` : attachmentInstruction;
}

function compactText(value: string, maxLength = 180): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted;
}

function decodeJsonString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatToolCall(toolCall: Record<string, unknown>): string | null {
  const action = decodeJsonString(toolCall.toolAction) || decodeJsonString(toolCall.toolSummary);
  const commandLine = decodeJsonString(toolCall.CommandLine);
  if (commandLine) {
    return compactText(`${action || "Bash"}: ${commandLine}`);
  }

  const absolutePath = decodeJsonString(toolCall.AbsolutePath);
  if (!absolutePath) {
    return null;
  }

  const startLine = Number(toolCall.StartLine);
  const endLine = Number(toolCall.EndLine);
  const lineSuffix =
    Number.isFinite(startLine) && startLine > 0
      ? Number.isFinite(endLine) && endLine > startLine
        ? `:${startLine}-${endLine}`
        : `:${startLine}`
      : "";

  return compactText(`${action || "Datei lesen"}: ${absolutePath}${lineSuffix}`);
}

export function extractAgyActivityLines(text: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string | null): void => {
    if (!line || seen.has(line)) {
      return;
    }

    seen.add(line);
    lines.push(line);
  };

  const printModeMatch = text.match(/Print mode: starting .*model="([^"]+)"/);
  if (printModeMatch?.[1]) {
    add(`AGY gestartet: ${printModeMatch[1]}`);
  }

  if (text.includes("streamGenerateContent")) {
    add("Gemini streamt Antwort");
  }

  for (const match of text.matchAll(/\{[^{}\n]*(?:"CommandLine"|"AbsolutePath")[^{}\n]*\}/g)) {
    try {
      add(formatToolCall(JSON.parse(match[0]) as Record<string, unknown>));
    } catch {
      // AGY stores protobuf-ish blobs around the JSON payloads; ignore partial matches.
    }
  }

  for (const match of text.matchAll(/Auto-approving tool confirmation: "([^"]+)"/g)) {
    add(`Tool bestätigt: ${match[1]}`);
  }

  for (const match of text.matchAll(/error executing cascade step: [^:]+: ([^\n]+)/g)) {
    add(`Tool-Fehler: ${compactText(match[1] ?? "")}`);
  }

  if (text.includes("Stream completed")) {
    add("AGY Stream abgeschlossen");
  }

  return lines;
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(filePath);
  const length = Math.min(fileStat.size, maxBytes);
  const start = Math.max(0, fileStat.size - length);
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, "r");
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }

  return buffer.toString("utf8");
}

async function listRecentFiles(directory: string, sinceMs: number): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const fileStat = await stat(filePath);
          return fileStat.mtimeMs >= sinceMs ? filePath : null;
        }),
    );

    return files.filter((filePath): filePath is string => Boolean(filePath));
  } catch {
    return [];
  }
}

function getAgyDataDir(): string {
  return (
    process.env.AGY_DATA_DIR?.trim() ||
    path.join(process.env.HOME ?? "", ".gemini", "antigravity-cli")
  );
}

function startAgyActivityMonitor(
  startedAtMs: number,
  onProgress?: (line: string) => void,
): {
  pollNow: () => Promise<void>;
  stop: () => void;
} | null {
  if (!onProgress) {
    return null;
  }

  const seen = new Set<string>();
  let stopped = false;

  const pollNow = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    const dataDir = getAgyDataDir();
    const sinceMs = startedAtMs - ACTIVITY_FILE_LOOKBACK_MS;
    const files = [
      ...(await listRecentFiles(path.join(dataDir, "log"), sinceMs)),
      ...(await listRecentFiles(path.join(dataDir, "conversations"), sinceMs)),
    ].filter((filePath) => /\.(log|db|db-wal)$/.test(filePath));

    const newestFiles = files.slice(-8);
    for (const filePath of newestFiles) {
      const text = await readFileTail(filePath, ACTIVITY_MAX_FILE_BYTES).catch(() => "");
      for (const line of extractAgyActivityLines(text)) {
        if (seen.has(line)) {
          continue;
        }

        seen.add(line);
        onProgress(line);
      }
    }
  };

  const interval = setInterval(() => {
    void pollNow().catch((error) => {
      logger.debug("[AGY] Failed to poll activity:", error);
    });
  }, ACTIVITY_POLL_INTERVAL_MS);
  interval.unref?.();

  void pollNow().catch((error) => {
    logger.debug("[AGY] Failed to poll initial activity:", error);
  });

  return {
    pollNow,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function spawnAgyFile(
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
    onProgress?: (line: string) => void;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const startedAtMs = Date.now();
    const monitor = startAgyActivityMonitor(startedAtMs, options.onProgress);
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      monitor?.stop();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
      reject(new Error(`AGY timed out after ${options.timeout}ms`));
    }, options.timeout);
    timeout.unref();

    const appendChunk = (chunks: Buffer[], chunk: Buffer | string): void => {
      if (settled) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentSize = chunks.reduce((size, item) => size + item.length, 0);
      if (currentSize + buffer.length > options.maxBuffer) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(new Error(`AGY output exceeded ${options.maxBuffer} bytes`));
        return;
      }

      chunks.push(buffer);
      for (const line of extractAgyActivityLines(buffer.toString("utf8"))) {
        options.onProgress?.(line);
      }
    };

    child.stdout?.on("data", (chunk) => appendChunk(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk) => appendChunk(stderrChunks, chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      monitor?.stop();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      void monitor
        ?.pollNow()
        .catch((error) => {
          logger.debug("[AGY] Failed to poll final activity:", error);
        })
        .finally(() => {
          monitor.stop();
        });
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      if (code !== 0) {
        reject(
          new Error(`AGY exited with code ${code ?? "null"} signal ${signal ?? "null"}\n${stderr}`),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export async function runAgyAgentPrompt({
  prompt,
  projectDirectory,
  model,
  attachments = [],
  onProgress,
}: AgyAgentRunOptions): Promise<AgyAgentRunResult> {
  if (activeRun) {
    throw new Error("AGY agent run already active");
  }

  activeRun = true;
  const modelName = resolveAgyModelName(model);
  let preparedAttachments: Awaited<ReturnType<typeof prepareAgyAttachments>> = null;

  try {
    preparedAttachments = await prepareAgyAttachments(attachments);
    const args = ["--add-dir", projectDirectory];
    if (preparedAttachments) {
      args.push("--add-dir", preparedAttachments.directory);
    }
    args.push(
      "--dangerously-skip-permissions",
      "--model",
      modelName,
      "--print",
      buildAgyPrompt(prompt, preparedAttachments?.filePaths ?? []),
    );

    logger.info(
      `[AGY] Starting agent run model="${modelName}" project=${projectDirectory} promptLength=${prompt.length}`,
    );
    const { stdout, stderr } = await spawnAgyFile(resolveAgyPath(), args, {
      cwd: projectDirectory,
      timeout: resolveTimeoutMs(),
      maxBuffer: MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        ANTIGRAVITY_AGENT: "1",
        AI_AGENT: "1",
      },
      onProgress,
    });

    const output = stdout.trim() || stderr.trim();
    return {
      output: output || "(AGY finished without output.)",
      modelName,
    };
  } catch (error) {
    logger.error("[AGY] Agent run failed:", error);
    throw error;
  } finally {
    if (preparedAttachments) {
      await rm(preparedAttachments.directory, { recursive: true, force: true });
    }
    activeRun = false;
  }
}
