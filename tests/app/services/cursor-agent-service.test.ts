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
    delete process.env.CURSOR_AGENT_TIMEOUT_MS;
    delete process.env.AGY_WORKER_MODE;
  });

  it("does not cancel a healthy run at the former ten-minute limit", async () => {
    vi.useFakeTimers();
    const child = createChild();
    mocked.spawnMock.mockReturnValue(child);
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");

    try {
      const result = runCursorAgentPrompt({
        prompt: "Run the long verification",
        projectDirectory: "/tmp/project",
      });

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.emit(
        "data",
        Buffer.from('{"type":"result","subtype":"success","result":"Done"}\n'),
      );
      child.emit("close", 0, null);
      await expect(result).resolves.toEqual({ output: "Done", modelName: "auto" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still enforces an explicit hard timeout", async () => {
    vi.useFakeTimers();
    const child = createChild();
    mocked.spawnMock.mockReturnValue(child);
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");

    try {
      const result = runCursorAgentPrompt({
        prompt: "Run verification",
        projectDirectory: "/tmp/project",
        timeoutMs: 1_000,
      });

      const rejection = expect(result).rejects.toThrow("Cursor Agent timed out after 1000ms");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("close", null, "SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs Cursor headlessly with the selected model and workspace", async () => {
    mocked.spawnMock.mockImplementation(() => {
      const child = createChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from('wal\n{"type":"result","subtype":"success","res'));
        child.stdout.emit("data", Buffer.from('ult":"Cursor result"}\n'));
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
        "stream-json",
        "--stream-partial-output",
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

  it("reports sanitized Cursor activity without exposing raw thinking", async () => {
    mocked.spawnMock.mockImplementation(() => {
      const child = createChild();
      setTimeout(() => {
        const events = [
          { type: "system", subtype: "init", model: "Auto" },
          { type: "thinking", subtype: "delta", text: "Inspecting files and planning tests" },
          { type: "thinking", subtype: "completed" },
          {
            type: "assistant",
            model_call_id: "call-1",
            message: {
              content: [{ type: "text", text: "I will inspect the failing test first." }],
            },
          },
          {
            type: "tool_call",
            subtype: "started",
            tool_call: {
              shellToolCall: {
                args: {
                  command:
                    "API_TOKEN=secret curl 'https://user:pass@example.test/run?access_token=also-secret'",
                },
              },
            },
          },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "Final answer only." }] },
          },
          { type: "result", subtype: "success", result: "Fixed and verified." },
        ];
        child.stdout.emit(
          "data",
          Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`),
        );
        child.emit("close", 0, null);
      }, 0);
      return child;
    });
    const onProgress = vi.fn();
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");

    await expect(
      runCursorAgentPrompt({
        prompt: "Fix the test",
        projectDirectory: "/tmp/project",
        onProgress,
      }),
    ).resolves.toEqual({ output: "Final answer only.", modelName: "auto" });

    expect(onProgress.mock.calls.flat()).toEqual([
      "Cursor verbunden: Auto",
      "Überlegung: Plant Tests und Verifikation",
      "Zwischenstand: I will inspect the failing test first.",
      "Terminal: API_TOKEN=[redacted] curl 'https://[redacted]@example.test/run?access_token=[redacted]'",
    ]);
    expect(onProgress.mock.calls.flat().join(" ")).not.toContain("Inspecting files");
    expect(onProgress.mock.calls.flat().join(" ")).not.toContain("secret");
    expect(onProgress.mock.calls.flat().join(" ")).not.toContain("user:pass");
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

describe("direct prompt cancellation", () => {
  beforeEach(() => {
    mocked.spawnMock.mockReset();
    delete process.env.AGY_WORKER_MODE;
  });

  it("transfers the Telegram preflight lease and releases it after its child closes", async () => {
    const child = createChild();
    mocked.spawnMock.mockReturnValue(child);
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");
    const { beginAgentRun, ownsAgentRun, isAgentRunActive } =
      await import("../../../src/app/services/agent-run-service.js");
    const run = beginAgentRun();
    const pending = runCursorAgentPrompt({
      prompt: "Prepared prompt",
      projectDirectory: "/tmp/project",
      ownedRun: run,
    });
    await vi.waitFor(() => expect(mocked.spawnMock).toHaveBeenCalledTimes(1));
    expect(ownsAgentRun(run)).toBe(true);
    await expect(
      runCursorAgentPrompt({
        prompt: "Duplicate",
        projectDirectory: "/tmp/project",
        ownedRun: run,
      }),
    ).rejects.toThrow("already active");
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"result","subtype":"success","result":"Done"}\n'),
    );
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ output: "Done", modelName: "auto" });
    expect(isAgentRunActive()).toBe(false);
    expect(mocked.spawnMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale preflight handle without dispatching or releasing another run", async () => {
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");
    const { beginAgentRun, ownsAgentRun } =
      await import("../../../src/app/services/agent-run-service.js");
    const stale = beginAgentRun();
    stale.finish();
    const current = beginAgentRun();
    try {
      await expect(
        runCursorAgentPrompt({
          prompt: "Stale",
          projectDirectory: "/tmp/project",
          ownedRun: stale,
        }),
      ).rejects.toThrow("no longer active");
      expect(mocked.spawnMock).not.toHaveBeenCalled();
      expect(ownsAgentRun(current)).toBe(true);
    } finally {
      current.finish();
    }
  });

  it("aborts preparation without spawning a prompt or retrying it", async () => {
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");
    const { abortActiveAgentRun, AgentRunAbortedError } =
      await import("../../../src/app/services/agent-run-service.js");
    const result = runCursorAgentPrompt({
      prompt: "Do not dispatch",
      projectDirectory: "/tmp/project",
    });
    const rejected = expect(result).rejects.toBeInstanceOf(AgentRunAbortedError);
    await expect(abortActiveAgentRun()).resolves.toBe(true);
    await rejected;
    expect(mocked.spawnMock).not.toHaveBeenCalled();
  });

  it("stops its active direct prompt only after the owned child closes", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      child.emit("close", null, "SIGTERM");
      return true;
    });
    mocked.spawnMock.mockReturnValue(child);
    const { runCursorAgentPrompt } =
      await import("../../../src/app/services/cursor-agent-service.js");
    const { abortActiveAgentRun, AgentRunAbortedError } =
      await import("../../../src/app/services/agent-run-service.js");
    const result = runCursorAgentPrompt({
      prompt: "Abort this prompt",
      projectDirectory: "/tmp/project",
    });
    const rejected = expect(result).rejects.toBeInstanceOf(AgentRunAbortedError);
    await vi.waitFor(() => expect(mocked.spawnMock).toHaveBeenCalledTimes(1));
    await expect(abortActiveAgentRun()).resolves.toBe(true);
    await rejected;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
});

it("does not let /abort kill a Cursor model discovery process", async () => {
  const child = createChild();
  mocked.spawnMock.mockReturnValue(child);
  const { listCursorModels } = await import("../../../src/app/services/cursor-agent-service.js");
  const { abortActiveAgentRun } = await import("../../../src/app/services/agent-run-service.js");
  const models = listCursorModels();
  expect(abortActiveAgentRun()).toBeNull();
  expect(child.kill).not.toHaveBeenCalled();
  child.stdout.emit("data", Buffer.from("auto - Auto\n"));
  child.emit("close", 0, null);
  await expect(models).resolves.toEqual([
    { providerID: "cursor", modelID: "auto", displayName: "Auto" },
  ]);
});

it("treats asynchronous attachment preparation failure after cancellation as an abort", async () => {
  mocked.spawnMock.mockReset();
  delete process.env.AGY_WORKER_MODE;
  const { runCursorAgentPrompt } =
    await import("../../../src/app/services/cursor-agent-service.js");
  const { abortActiveAgentRun, AgentRunAbortedError } =
    await import("../../../src/app/services/agent-run-service.js");
  const result = runCursorAgentPrompt({
    prompt: "Do not dispatch",
    projectDirectory: "/tmp/project",
    attachments: [
      { type: "file", mime: "text/plain", filename: "invalid.txt", url: "not-a-data-uri" },
    ],
  });
  const rejected = expect(result).rejects.toBeInstanceOf(AgentRunAbortedError);
  await expect(abortActiveAgentRun()).resolves.toBe(true);
  await rejected;
  expect(mocked.spawnMock).not.toHaveBeenCalled();
});
