import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  consumePromptResponseMode,
  processUserPrompt,
  type ProcessPromptDeps,
} from "../../../src/bot/handlers/prompt.js";
import {
  __resetPendingAttachmentsForTests,
  getPendingAttachments,
  storePendingAttachments,
} from "../../../src/app/services/pending-attachment-service.js";
import {
  markAppRunning,
  markAppShuttingDown,
} from "../../../src/app/services/app-lifecycle-service.js";

const mocked = vi.hoisted(() => ({
  currentProject: { id: "project-1", worktree: "D:\\Projects\\Repo" },
  currentSession: {
    id: "session-1",
    title: "Session",
    directory: "D:\\Projects\\Repo",
  } as { id: string; title: string; directory: string } | null,
  sessionStatusMock: vi.fn(),
  sessionPromptMock: vi.fn(),
  sessionPromptAsyncMock: vi.fn(),
  sessionCreateMock: vi.fn(),
  suppressionRegisterMock: vi.fn(),
  safeBackgroundTaskMock: vi.fn(),
  setSessionSummaryMock: vi.fn(),
  setBotAndChatIdMock: vi.fn(),
  attachToSessionMock: vi.fn(),
  getTtsModeMock: vi.fn(),
  getAssistantModeMock: vi.fn(),
  storedModel: {
    providerID: "openai",
    modelID: "gpt-5",
    variant: "default",
  },
  runAgyAgentPromptMock: vi.fn(),
  isAgyAgentRunActiveMock: vi.fn(),
  resolveSelectedAgyAccountMock: vi.fn(),
  runCursorAgentPromptMock: vi.fn(),
  isCursorAgentRunActiveMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      status: mocked.sessionStatusMock,
      prompt: mocked.sessionPromptMock,
      promptAsync: mocked.sessionPromptAsyncMock,
      create: mocked.sessionCreateMock,
    },
  },
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => mocked.currentSession),
  setCurrentSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../../../src/app/services/session-cache-service.js", () => ({
  ingestSessionInfoForCache: vi.fn(),
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: vi.fn(() => mocked.currentProject),
  getTtsMode: mocked.getTtsModeMock,
  getAssistantMode: mocked.getAssistantModeMock,
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: vi.fn(() => mocked.storedModel),
}));

vi.mock("../../../src/app/services/agy-agent-service.js", () => ({
  isAgyAgentRunActive: mocked.isAgyAgentRunActiveMock,
  resolveAgyModelName: vi.fn(() => "Gemini 3.5 Flash (High)"),
  runAgyAgentPrompt: mocked.runAgyAgentPromptMock,
}));

vi.mock("../../../src/app/services/agy-account-service.js", () => ({
  resolveSelectedAgyAccount: mocked.resolveSelectedAgyAccountMock,
}));

vi.mock("../../../src/app/services/cursor-agent-service.js", () => ({
  isCursorAgentRunActive: mocked.isCursorAgentRunActiveMock,
  runCursorAgentPrompt: mocked.runCursorAgentPromptMock,
}));

vi.mock("../../../src/bot/pinned/pinned-message-manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: vi.fn(() => true),
    initialize: vi.fn(),
    getState: vi.fn(() => ({ messageId: 1 })),
    onSessionChange: vi.fn(),
    clear: vi.fn(),
    getContextInfo: vi.fn(() => null),
  },
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: vi.fn(),
    clearContext: vi.fn(),
    updateAgent: vi.fn(),
  },
}));

vi.mock("../../../src/app/managers/summary-aggregation-manager.js", () => ({
  summaryAggregator: {
    setSession: mocked.setSessionSummaryMock,
    setBotAndChatId: mocked.setBotAndChatIdMock,
    clear: vi.fn(),
  },
}));

vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: {
    clear: vi.fn(),
    getSnapshot: vi.fn(() => null),
  },
  clearAllInteractionState: vi.fn(),
}));

vi.mock("../../../src/utils/safe-background-task.js", () => ({
  safeBackgroundTask: vi.fn((options) => {
    mocked.safeBackgroundTaskMock(options);
  }),
}));

vi.mock("../../../src/utils/error-format.js", () => ({
  formatErrorDetails: vi.fn(() => "formatted error"),
}));

vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: {
    markBusy: vi.fn(),
    markIdle: vi.fn(),
    clearAll: vi.fn(),
  },
}));

vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: {
    startRun: vi.fn(),
    clearRun: vi.fn(),
    clearAll: vi.fn(),
  },
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
  detachAttachedSession: vi.fn(),
  markAttachedSessionBusy: vi.fn().mockResolvedValue(undefined),
  markAttachedSessionIdle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/managers/external-input-suppression-manager.js", () => ({
  externalUserInputSuppressionManager: {
    register: mocked.suppressionRegisterMock,
  },
}));

function createContext(): Context {
  return {
    chat: { id: 777 },
    reply: vi.fn().mockResolvedValue({ message_id: 100 }),
  } as unknown as Context;
}

function createDeps(): ProcessPromptDeps {
  return {
    bot: {
      api: {
        editMessageText: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Bot<Context>,
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

function getScheduledBackgroundTask(): {
  task: () => Promise<unknown>;
  onSuccess?: (value: { error: unknown | null }) => void;
  onError?: (error: unknown) => void;
} {
  const [[options]] = mocked.safeBackgroundTaskMock.mock.calls as [
    [
      {
        task: () => Promise<unknown>;
        onSuccess?: (value: { error: unknown | null }) => void;
        onError?: (error: unknown) => void;
      },
    ],
  ];

  return options;
}

describe("bot/handlers/prompt", () => {
  beforeEach(() => {
    markAppRunning();
    __resetPendingAttachmentsForTests();
    mocked.currentProject = { id: "project-1", worktree: "D:\\Projects\\Repo" };
    mocked.currentSession = {
      id: "session-1",
      title: "Session",
      directory: "D:\\Projects\\Repo",
    };
    mocked.sessionStatusMock.mockReset();
    mocked.sessionPromptMock.mockReset();
    mocked.sessionPromptAsyncMock.mockReset();
    mocked.sessionCreateMock.mockReset();
    mocked.suppressionRegisterMock.mockReset();
    mocked.safeBackgroundTaskMock.mockReset();
    mocked.setSessionSummaryMock.mockReset();
    mocked.setBotAndChatIdMock.mockReset();
    mocked.attachToSessionMock.mockReset();
    mocked.getTtsModeMock.mockReset();
    mocked.getAssistantModeMock.mockReset();
    mocked.storedModel = {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "default",
    };
    mocked.runAgyAgentPromptMock.mockReset();
    mocked.isAgyAgentRunActiveMock.mockReset();
    mocked.resolveSelectedAgyAccountMock.mockReset();
    mocked.runCursorAgentPromptMock.mockReset();
    mocked.isCursorAgentRunActiveMock.mockReset();
    mocked.getTtsModeMock.mockReturnValue("off");
    mocked.getAssistantModeMock.mockReturnValue("opencode");
    mocked.isAgyAgentRunActiveMock.mockReturnValue(false);
    mocked.isCursorAgentRunActiveMock.mockReturnValue(false);
    mocked.resolveSelectedAgyAccountMock.mockResolvedValue({
      alias: "default",
      homeDirectory: "/home/tim",
      isDefault: true,
    });
    mocked.runAgyAgentPromptMock.mockResolvedValue({
      output: "AGY done",
      modelName: "Gemini 3.5 Flash (High)",
    });
    mocked.runCursorAgentPromptMock.mockResolvedValue({
      output: "Cursor done",
      modelName: "gpt-5.6-sol-high",
    });
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });

    mocked.sessionStatusMock.mockResolvedValue({
      data: {
        "session-1": { type: "idle" },
      },
      error: null,
    });
    mocked.sessionPromptMock.mockResolvedValue({ data: {}, error: null });
    mocked.sessionPromptAsyncMock.mockResolvedValue({ data: {}, error: null });
  });

  it("does not dispatch a prompt after gateway shutdown has started", async () => {
    markAppShuttingDown();
    const ctx = createContext();

    const handled = await processUserPrompt(ctx, "Do not lose this request", createDeps());

    expect(handled).toBe(false);
    expect(mocked.safeBackgroundTaskMock).not.toHaveBeenCalled();
    expect(mocked.runAgyAgentPromptMock).not.toHaveBeenCalled();
    expect(mocked.sessionPromptAsyncMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "The bot is restarting. This request was not started; please send it again shortly.",
    );
  });

  it("registers suppression entry for text prompts", async () => {
    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);
    expect(mocked.attachToSessionMock).toHaveBeenCalledWith({
      bot: expect.any(Object),
      chatId: 777,
      session: {
        id: "session-1",
        title: "Session",
        directory: "D:\\Projects\\Repo",
      },
      ensureEventSubscription: expect.any(Function),
    });
    expect(mocked.suppressionRegisterMock).toHaveBeenCalledWith("session-1", "Review README");
  });

  it("starts prompts through promptAsync instead of the streaming prompt endpoint", async () => {
    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    expect(mocked.sessionPromptAsyncMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "D:\\Projects\\Repo",
      parts: [{ type: "text", text: "Review README" }],
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      variant: "default",
    });
    expect(mocked.sessionPromptMock).not.toHaveBeenCalled();
  });

  it("dispatches prompts through AGY agent mode without creating an OpenCode session", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    mocked.storedModel = {
      providerID: "antigravity",
      modelID: "gemini-3.5-flash-high",
      variant: "default",
    };
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Create a file", deps);

    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith("🚀 AGY agent started with Gemini 3.5 Flash (High)...");
    expect(mocked.sessionStatusMock).not.toHaveBeenCalled();
    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
    expect(mocked.attachToSessionMock).not.toHaveBeenCalled();

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    expect(mocked.runAgyAgentPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Create a file",
        projectDirectory: "D:\\Projects\\Repo",
        model: {
          providerID: "antigravity",
          modelID: "gemini-3.5-flash-high",
          variant: "default",
        },
        accountHome: "/home/tim",
        onProgress: expect.any(Function),
      }),
    );
  });

  it("passes image attachments to AGY agent mode", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    mocked.storedModel = {
      providerID: "antigravity",
      modelID: "gemini-3.5-flash-high",
      variant: "default",
    };
    const attachment = {
      type: "file",
      mime: "image/png",
      filename: "screen.png",
      url: "data:image/png;base64,aW1hZ2U=",
    } as const;

    const handled = await processUserPrompt(createContext(), "Review this UI", createDeps(), [
      attachment,
    ]);

    expect(handled).toBe(true);
    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();
    expect(mocked.runAgyAgentPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [attachment] }),
    );
  });

  it("dispatches prompts and image attachments through Cursor mode", async () => {
    mocked.getAssistantModeMock.mockReturnValue("cursor");
    mocked.storedModel = {
      providerID: "cursor",
      modelID: "gpt-5.6-sol-high",
      variant: "default",
    };
    const attachment = {
      type: "file",
      mime: "image/png",
      filename: "screen.png",
      url: "data:image/png;base64,aW1hZ2U=",
    } as const;

    const handled = await processUserPrompt(createContext(), "Fix this UI", createDeps(), [
      attachment,
    ]);

    expect(handled).toBe(true);
    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();
    expect(mocked.runCursorAgentPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Fix this UI",
        projectDirectory: "D:\\Projects\\Repo",
        model: mocked.storedModel,
        attachments: [attachment],
      }),
    );
  });

  it("uses and clears a pending photo with the next AGY prompt", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    mocked.storedModel = {
      providerID: "antigravity",
      modelID: "gemini-3.5-flash-high",
      variant: "default",
    };
    const attachment = {
      type: "file",
      mime: "image/png",
      filename: "screen.png",
      url: "data:image/png;base64,aW1hZ2U=",
    } as const;
    storePendingAttachments(777, [attachment]);

    const handled = await processUserPrompt(createContext(), "Fix this layout", createDeps());

    expect(handled).toBe(true);
    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();
    expect(mocked.runAgyAgentPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [attachment] }),
    );
    expect(getPendingAttachments(777)).toEqual([]);
  });

  it("rejects an unavailable AGY account without falling back", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    mocked.resolveSelectedAgyAccountMock.mockRejectedValue(new Error("profile missing"));
    const ctx = createContext();

    const handled = await processUserPrompt(ctx, "Review repo", createDeps());

    expect(handled).toBe(false);
    expect(mocked.runAgyAgentPromptMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "This account profile is unavailable. Open /account again.",
    );
  });

  it("uses AGY mode with its default model when the selected model came from OpenCode", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    mocked.storedModel = {
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      variant: "max",
    };
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Create GitHub issues", deps);

    expect(handled).toBe(true);
    expect(mocked.attachToSessionMock).not.toHaveBeenCalled();

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    expect(mocked.runAgyAgentPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Create GitHub issues",
        model: {
          providerID: "deepseek",
          modelID: "deepseek-v4-pro",
          variant: "max",
        },
      }),
    );
    expect(mocked.sessionPromptAsyncMock).not.toHaveBeenCalled();
  });

  it("streams AGY activity updates into the Telegram progress message", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    mocked.storedModel = {
      providerID: "antigravity",
      modelID: "gemini-3.5-flash-high",
      variant: "default",
    };
    mocked.runAgyAgentPromptMock.mockImplementation(async (options) => {
      options.onProgress?.("Run quality check: pnpm quality");
      return {
        output: "AGY done",
        modelName: "Gemini 3.5 Flash (High)",
      };
    });
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Review repo", deps);

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();
    backgroundTask.onSuccess?.({
      output: "AGY done",
      modelName: "Gemini 3.5 Flash (High)",
    } as never);

    expect(deps.bot.api.editMessageText).toHaveBeenLastCalledWith(
      777,
      100,
      expect.stringContaining("Run quality check: pnpm quality"),
    );
  });

  it("still notifies the user when promptAsync reports a real start error", async () => {
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Review README", deps);

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    backgroundTask.onSuccess?.({ error: new Error("request start failed") });

    expect(deps.bot.api.sendMessage).toHaveBeenCalledWith(
      777,
      "Failed to send request to OpenCode.",
    );
  });

  it("still notifies the user when promptAsync rejects before the run starts", async () => {
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Review README", deps);

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    const startError = new Error("network down");
    mocked.sessionPromptAsyncMock.mockRejectedValueOnce(startError);

    await backgroundTask.task().catch((error) => {
      backgroundTask.onError?.(error);
    });

    expect(deps.bot.api.sendMessage).toHaveBeenCalledWith(
      777,
      "Failed to send request to OpenCode.",
    );
  });

  it("does not register suppression entry for file-only prompts", async () => {
    const handled = await processUserPrompt(createContext(), "", createDeps(), [
      {
        type: "file",
        mime: "text/plain",
        url: "data:text/plain;base64,SGVsbG8=",
      } as never,
    ]);

    expect(handled).toBe(true);
    expect(mocked.suppressionRegisterMock).not.toHaveBeenCalled();
  });

  it("keeps text prompts text-only when TTS mode is auto", async () => {
    mocked.getTtsModeMock.mockReturnValue("auto");

    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);
    expect(consumePromptResponseMode("session-1")).toBe("text_only");
  });

  it("uses plural placeholder text for multiple file-only prompts", async () => {
    const handled = await processUserPrompt(createContext(), "", createDeps(), [
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,Zmlyc3Q=",
      } as never,
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,c2Vjb25k",
      } as never,
    ]);

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    expect(mocked.sessionPromptAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          { type: "text", text: "See attached files" },
          expect.objectContaining({ type: "file", mime: "image/png" }),
          expect.objectContaining({ type: "file", mime: "image/png" }),
        ],
      }),
    );
  });
});
