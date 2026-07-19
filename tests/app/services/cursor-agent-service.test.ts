import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocked.spawnMock,
}));

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("app/services/cursor-agent-service", () => {
  beforeEach(() => {
    mocked.spawnMock.mockReset();
    process.env.CURSOR_AGENT_PATH = "/test/cursor-agent";
    delete process.env.AGY_WORKER_MODE;
  });

  it("runs Cursor headlessly with the selected model and workspace", async () => {
    mocked.spawnMock.mockImplementation(() => {
      const child = createChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from("wal\nCursor result\n"));
        child.emit("close", 0, null);
      }, 0);
      return child;
    });
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");

    await expect(
      runCursorAgentPrompt({
        prompt: "Review this repo",
        projectDirectory: "/tmp/project",
        model: { providerID: "cursor", modelID: "gpt-5.6-sol-high" },
      }),
    ).resolves.toEqual({ output: "Cursor result", modelName: "gpt-5.6-sol-high" });
    expect(mocked.spawnMock).toHaveBeenCalledWith(
      "/test/cursor-agent",
      [
        "-p",
        "--output-format",
        "text",
        "--model",
        "gpt-5.6-sol-high",
        "--trust",
        "--yolo",
        "--workspace",
        "/tmp/project",
        "Review this repo",
      ],
      expect.objectContaining({ cwd: "/tmp/project", stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("discovers and searches the authenticated Cursor model catalog", async () => {
    mocked.spawnMock.mockImplementation(() => {
      const child = createChild();
      setTimeout(() => {
        child.stdout.emit(
          "data",
          Buffer.from(
            "Available models\n\nauto - Auto (default)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\nclaude-opus-4-8-thinking-high - Opus 4.8 1M Thinking\n",
          ),
        );
        child.emit("close", 0, null);
      }, 0);
      return child;
    });
    const { searchCursorModels } =
      await import("../../../src/app/services/cursor-agent-service.js");

    await expect(searchCursorModels("opus")).resolves.toEqual([
      {
        providerID: "cursor",
        modelID: "claude-opus-4-8-thinking-high",
        displayName: "Opus 4.8 1M Thinking",
      },
    ]);
  });

  it("writes attachments privately and removes them after Cursor exits", async () => {
    let attachmentDirectory = "";
    mocked.spawnMock.mockImplementation((_file: string, args: string[]) => {
      const child = createChild();
      attachmentDirectory = args[args.indexOf("--add-dir") + 1] as string;
      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    });
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");

    await runCursorAgentPrompt({
      prompt: "Inspect image",
      projectDirectory: "/tmp/project",
      attachments: [
        {
          type: "file",
          mime: "image/png",
          filename: "../screen.png",
          url: "data:image/png;base64,aW1hZ2U=",
        },
      ],
    });

    expect(attachmentDirectory).toMatch(/opencode-telegram-cursor-/);
    await expect(access(attachmentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
