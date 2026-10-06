import os from "node:os";
import path from "node:path";

export function resolveAgyCliPath(): string {
  return process.env.AGY_CLI_PATH?.trim() || path.join(os.homedir(), ".local", "bin", "agy");
}

export function resolveTmuxPath(): string {
  return process.env.TMUX_PATH?.trim() || "tmux";
}

export function resolveCursorAgentPath(): string {
  return (
    process.env.CURSOR_AGENT_PATH?.trim() ||
    path.join(os.homedir(), ".local", "bin", "cursor-agent")
  );
}
