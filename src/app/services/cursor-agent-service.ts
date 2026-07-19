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
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_LINE_CHARS = 512 * 1024;
const MAX_PROGRESS_TEXT_CHARS = 240;

export interface CursorAgentRunOptions {
  prompt: string;
  projectDirectory: string;
  model?: ModelInfo;
  attachments?: FilePartInput[];
  timeoutMs?: number;
  notification?: AgyJobNotification;
  onProgress?: (line: string) => void;
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

function normalizeCursorOutput(output: string): string {
  const trimmed = output.trim();
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 1 && lines[0]?.trim().toLowerCase() === "wal") {
    return lines.slice(1).join("\n").trim();
  }
  return trimmed;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function readString(object: JsonObject | null, ...keys: string[]): string {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function compactProgressText(value: string, maxLength = MAX_PROGRESS_TEXT_CHARS): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted;
}

function redactCommand(command: string): string {
  return command
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:api_?key|access_?token|token|secret|password)=)[^&\s'"]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(^|\s)([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)=(?:'[^']*'|"[^"]*"|\S+)/gi,
      "$1$2=[redacted]",
    )
    .replace(
      /(\s--(?:api-?key|token|secret|password|passwd))(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gi,
      "$1 [redacted]",
    )
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, "$1[redacted]");
}

function summarizeThinking(text: string): string {
  const normalized = text.toLowerCase();
  if (/\b(branch|commit|push|pull request|\bpr\b|merge)\b/.test(normalized)) {
    return "Plant Git- und PR-Schritte";
  }
  if (/\b(tests?|verify|verification|validation|lint|quality|checks?)\b/.test(normalized)) {
    return "Plant Tests und Verifikation";
  }
  if (
    /\b(inspect(?:ing|ed|s)?|read(?:ing|s)?|search(?:ing|ed|es)?|find(?:ing|s)?|analy[sz](?:e|ing|ed)?|review(?:ing|ed|s)?|trac(?:e|ing|ed))\b/.test(
      normalized,
    )
  ) {
    return "Analysiert Code und relevante Dateien";
  }
  if (/\b(edit|implement|change|fix|update|write|refactor)\b/.test(normalized)) {
    return "Plant die nächsten Änderungen";
  }
  return "Plant den nächsten Arbeitsschritt";
}

function humanizeToolName(value: string): string {
  const normalized = value.replace(/ToolCall$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return normalized ? normalized[0]?.toUpperCase() + normalized.slice(1) : "Tool";
}

function formatCursorToolActivity(event: JsonObject): string | null {
  const toolCall = asObject(event.tool_call);
  const entry = Object.entries(toolCall ?? {}).find(
    ([key, value]) => key.endsWith("ToolCall") && asObject(value),
  );
  if (!entry) {
    return null;
  }

  const [toolKey, toolValue] = entry;
  const args = asObject(asObject(toolValue)?.args);
  const command = readString(args, "command", "commandLine", "cmd");
  if (command) {
    return `Terminal: ${compactProgressText(redactCommand(command))}`;
  }

  const pathValue = readString(
    args,
    "path",
    "filePath",
    "targetFile",
    "targetDirectory",
    "directory",
    "cwd",
  );
  const pattern = readString(args, "globPattern", "pattern", "query", "searchTerm");
  const normalizedTool = toolKey.toLowerCase();
  if (normalizedTool.includes("glob") || normalizedTool.includes("search")) {
    const details = [pattern, pathValue].filter(Boolean).join(" in ");
    return `Dateien suchen${details ? `: ${compactProgressText(details)}` : ""}`;
  }
  if (normalizedTool.includes("read")) {
    return `Datei lesen${pathValue ? `: ${compactProgressText(pathValue)}` : ""}`;
  }
  if (normalizedTool.includes("edit") || normalizedTool.includes("write")) {
    return `Datei bearbeiten${pathValue ? `: ${compactProgressText(pathValue)}` : ""}`;
  }
  if (normalizedTool.includes("delete")) {
    return `Datei löschen${pathValue ? `: ${compactProgressText(pathValue)}` : ""}`;
  }

  const details = compactProgressText(pattern || pathValue);
  return `${humanizeToolName(toolKey)}${details ? `: ${details}` : ""}`;
}

function readAssistantText(event: JsonObject): string {
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((item) => readString(asObject(item), "text"))
    .filter(Boolean)
    .join("");
}

function createCursorStreamCollector(onProgress?: (line: string) => void): {
  push: (text: string) => void;
  finish: () => string;
} {
  let pending = "";
  let discardingOversizedLine = false;
  let finalResult = "";
  let finalAssistantText = "";
  let thinkingText = "";
  const fallbackLines: string[] = [];
  const seenProgress = new Set<string>();

  const emitProgress = (line: string): void => {
    if (!line || seenProgress.has(line)) {
      return;
    }
    seenProgress.add(line);
    onProgress?.(line);
  };

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase() === "wal") {
      return;
    }

    let event: JsonObject;
    try {
      event = JSON.parse(trimmed) as JsonObject;
    } catch {
      fallbackLines.push(trimmed);
      while (fallbackLines.length > 16) {
        fallbackLines.shift();
      }
      return;
    }

    const type = readString(event, "type");
    const subtype = readString(event, "subtype");
    if (type === "system" && subtype === "init") {
      const model = readString(event, "model");
      emitProgress(`Cursor verbunden${model ? `: ${model}` : ""}`);
      return;
    }
    if (type === "thinking") {
      if (subtype === "delta") {
        const delta = typeof event.text === "string" ? event.text : "";
        thinkingText = `${thinkingText}${delta}`.slice(-4_096);
      } else if (subtype === "completed" && thinkingText.trim()) {
        emitProgress(`Überlegung: ${summarizeThinking(thinkingText)}`);
        thinkingText = "";
      }
      return;
    }
    if (type === "assistant") {
      const text = compactProgressText(readAssistantText(event), 200);
      if (text && typeof event.model_call_id === "string") {
        emitProgress(`Zwischenstand: ${text}`);
      } else if (text && typeof event.timestamp_ms !== "number") {
        finalAssistantText = readAssistantText(event).trim();
      }
      return;
    }
    if (type === "tool_call" && subtype === "started") {
      const activity = formatCursorToolActivity(event);
      if (activity) {
        emitProgress(activity);
      }
      return;
    }
    if (type === "result" && subtype === "success") {
      finalResult = readString(event, "result");
    }
  };

  const push = (text: string): void => {
    let remaining = text;
    while (remaining) {
      if (discardingOversizedLine) {
        const newline = remaining.indexOf("\n");
        if (newline === -1) {
          return;
        }
        discardingOversizedLine = false;
        remaining = remaining.slice(newline + 1);
        continue;
      }

      const newline = remaining.indexOf("\n");
      if (newline === -1) {
        pending += remaining;
        if (pending.length > MAX_STREAM_LINE_CHARS) {
          pending = "";
          discardingOversizedLine = true;
        }
        return;
      }

      pending += remaining.slice(0, newline);
      consumeLine(pending);
      pending = "";
      remaining = remaining.slice(newline + 1);
    }
  };

  return {
    push,
    finish: () => {
      if (pending && !discardingOversizedLine) {
        consumeLine(pending);
      }
      return finalAssistantText || finalResult || normalizeCursorOutput(fallbackLines.join("\n"));
    },
  };
}

function runCursorCommand(
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    maxBuffer: number;
    captureStdout?: boolean;
    onStdoutText?: (text: string) => void;
  },
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

    child.stdout?.on("data", (chunk: Buffer | string) => {
      options.onStdoutText?.(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      if (options.captureStdout !== false) {
        append(stdout, chunk);
      }
    });
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
    const streamCollector = createCursorStreamCollector(options.onProgress);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
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
    const { stderr } = await runCursorCommand(args, {
      cwd: options.projectDirectory,
      timeoutMs: options.timeoutMs ?? resolveTimeoutMs(),
      maxBuffer: MAX_BUFFER_BYTES,
      captureStdout: false,
      onStdoutText: streamCollector.push,
    });
    return {
      output: streamCollector.finish() || stderr.trim() || "(Cursor finished without output.)",
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
