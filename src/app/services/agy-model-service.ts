import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { resolveAgyCliPath } from "../../runtime/executable-paths.js";
import { resolveSelectedAgyAccount } from "./agy-account-service.js";
import type { ModelInfo } from "../types/model.js";

export const DEFAULT_AGY_MODEL_ID = "gemini-3.8-flash-high";

export interface AgyModelInfo {
  providerID: "antigravity";
  modelID: string;
  displayName: string;
}

const cache = new Map<string, { expiresAt: number; models: AgyModelInfo[] }>();

export function parseAgyModels(output: string): AgyModelInfo[] {
  const models = new Map<string, AgyModelInfo>();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9.-]*)\t+(.+)$/.exec(line.trim());
    if (!match || Buffer.byteLength(`model:antigravity:${match[1]}`) > 64) {
      continue;
    }
    models.set(match[1], {
      providerID: "antigravity",
      modelID: match[1],
      displayName: match[2].trim(),
    });
  }
  if (models.size === 0) {
    throw new Error("AGY returned no readable model catalog; no static fallback was selected");
  }
  return [...models.values()];
}

export async function listAgyModels(accountHome?: string): Promise<AgyModelInfo[]> {
  const home = accountHome ?? (await resolveSelectedAgyAccount()).homeDirectory;
  const executable = resolveAgyCliPath();
  const key = `${executable}\0${home}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (path.resolve(home) !== os.homedir()) {
    delete env.AGY_DATA_DIR;
    delete env.GEMINI_API_KEY;
  }
  const { stdout } = await promisify(execFile)(executable, ["models"], {
    env,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const models = parseAgyModels(stdout);
  cache.set(key, { models, expiresAt: Date.now() + 60000 });
  return models;
}

export async function resolveAgyModel(
  model?: ModelInfo,
  accountHome?: string,
): Promise<AgyModelInfo> {
  if (model && model.providerID !== "antigravity") {
    throw new Error("Selected provider is not antigravity; choose an AGY model explicitly");
  }
  const id = model?.modelID ?? DEFAULT_AGY_MODEL_ID;
  const available = (await listAgyModels(accountHome)).find((entry) => entry.modelID === id);
  if (!available) {
    throw new Error(
      `AGY model is unavailable: ${id}. Select an available model; no fallback was used`,
    );
  }
  return available;
}

export async function searchAgyModels(query: string, limit = 10): Promise<AgyModelInfo[]> {
  const normalized = query.trim().toLowerCase();
  return (await listAgyModels())
    .filter((model) => `${model.modelID} ${model.displayName}`.toLowerCase().includes(normalized))
    .slice(0, limit);
}
