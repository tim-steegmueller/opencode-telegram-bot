import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocked.spawnMock,
}));

describe("app/services/agy-agent-service", () => {
  beforeEach(() => {
    mocked.spawnMock.mockReset();
    delete process.env.AGY_CLI_PATH;
    delete process.env.AGY_AGENT_TIMEOUT_MS;
  });

  it("maps stored antigravity model IDs to AGY CLI model names", async () => {
    const { resolveAgyModelName } = await import("../../../src/app/services/agy-agent-service.js");

    expect(
      resolveAgyModelName({
        providerID: "antigravity",
        modelID: "gemini-3.5-flash-high",
      }),
    ).toBe("Gemini 3.5 Flash (High)");
    expect(
      resolveAgyModelName({
        providerID: "openai",
        modelID: "gpt-5",
      }),
    ).toBe("Gemini 3.5 Flash (High)");
  });

  it("runs AGY with project directory, YOLO permissions, model, and print prompt", async () => {
    process.env.AGY_CLI_PATH = "/tmp/fake-agy";
    mocked.spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      setTimeout(() => {
        child.stdout.emit("data", Buffer.from("done\n"));
        child.emit("close", 0, null);
      }, 0);

      return child;
    });

    const { runAgyAgentPrompt } = await import("../../../src/app/services/agy-agent-service.js");

    const result = await runAgyAgentPrompt({
      prompt: "Create a file",
      projectDirectory: "/tmp/project",
      model: {
        providerID: "antigravity",
        modelID: "claude-opus-4.6",
      },
    });

    expect(result).toEqual({
      output: "done",
      modelName: "Claude Opus 4.6 (Thinking)",
    });
    expect(mocked.spawnMock).toHaveBeenCalledWith(
      "/tmp/fake-agy",
      [
        "--add-dir",
        "/tmp/project",
        "--dangerously-skip-permissions",
        "--model",
        "Claude Opus 4.6 (Thinking)",
        "--print",
        "Create a file",
      ],
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("resolves the default AGY binary from the current home directory", async () => {
    mocked.spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    });

    const { runAgyAgentPrompt } = await import("../../../src/app/services/agy-agent-service.js");
    await runAgyAgentPrompt({ prompt: "test", projectDirectory: "/tmp/project" });

    expect(mocked.spawnMock.mock.calls[0]?.[0]).toBe(
      path.join(os.homedir(), ".local", "bin", "agy"),
    );
  });

  it("writes Telegram attachments for AGY and removes them after the run", async () => {
    process.env.AGY_CLI_PATH = "/tmp/fake-agy";
    mocked.spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    });

    const { runAgyAgentPrompt } = await import("../../../src/app/services/agy-agent-service.js");
    await runAgyAgentPrompt({
      prompt: "Review the screenshot",
      projectDirectory: "/tmp/project",
      accountHome: "/tmp/account-home",
      attachments: [
        {
          type: "file",
          mime: "image/png",
          filename: "../screen.png",
          url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
        },
      ],
    });

    const args = mocked.spawnMock.mock.calls[0]?.[1] as string[];
    const attachmentDirectory = args[3];
    const prompt = args.at(-1) ?? "";

    expect(attachmentDirectory).toMatch(/opencode-telegram-agy-/);
    expect(prompt).toContain(`${attachmentDirectory}/1-screen.png`);
    expect(mocked.spawnMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({ HOME: "/tmp/account-home" }),
      }),
    );
    await expect(access(attachmentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("extracts safe activity updates from AGY log and conversation text", async () => {
    const { extractAgyActivityLines } =
      await import("../../../src/app/services/agy-agent-service.js");

    const lines = extractAgyActivityLines(`
I0620 13:51:42.225687 printmode.go:85] Print mode: starting (promptLength=28, model="Gemini 3.5 Flash (High)", conversationID="")
I0620 13:51:46.717146 http_helpers.go:198] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0xbe314e164f568d65
{"CommandLine":"pnpm quality","Cwd":"/home/tim/project","WaitMsBeforeAsync":10000,"toolAction":"Run quality check","toolSummary":"Run quality checks"}
{"AbsolutePath":"/home/tim/project/package.json","EndLine":80,"StartLine":1,"toolAction":"View package.json scripts","toolSummary":"View package.json"}
E0620 13:52:24.931485 log.go:398] error executing cascade step: CORTEX_STEP_TYPE_RUN_COMMAND: This command requires access to files outside the workspace and cannot be run automatically.
I0620 13:53:14.571365 server.go:840] Stream goroutine exited for 25ac551c, sending completion signal
I0620 13:53:14.571379 conversation_manager.go:601] Stream completed for 25ac551c, clearing ResponsePending
`);

    expect(lines).toEqual([
      "AGY gestartet: Gemini 3.5 Flash (High)",
      "Gemini streamt Antwort",
      "Run quality check: pnpm quality",
      "View package.json scripts: /home/tim/project/package.json:1-80",
      "Tool-Fehler: This command requires access to files outside the workspace and cannot be run automatically.",
      "AGY Stream abgeschlossen",
    ]);
  });
});
