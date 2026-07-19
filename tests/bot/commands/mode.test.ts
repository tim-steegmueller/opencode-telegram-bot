import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { MODE_CALLBACK_PREFIX, modeCommand } from "../../../src/bot/commands/mode-command.js";
import { handleModeCallback } from "../../../src/bot/callbacks/mode-callback-handler.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  getAssistantModeMock: vi.fn(),
  getCurrentModelMock: vi.fn(),
  setAssistantModeMock: vi.fn(),
  selectModelMock: vi.fn(),
  keyboardInitializeMock: vi.fn(),
  keyboardUpdateModelMock: vi.fn(),
  keyboardSendUpdateMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getAssistantMode: mocked.getAssistantModeMock,
  getCurrentModel: mocked.getCurrentModelMock,
  setAssistantMode: mocked.setAssistantModeMock,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  selectModel: mocked.selectModelMock,
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: mocked.keyboardInitializeMock,
    updateModel: mocked.keyboardUpdateModelMock,
    sendKeyboardUpdate: mocked.keyboardSendUpdateMock,
  },
}));

describe("bot/commands/mode-command", () => {
  beforeEach(() => {
    mocked.getAssistantModeMock.mockReset();
    mocked.getCurrentModelMock.mockReset();
    mocked.setAssistantModeMock.mockReset();
    mocked.selectModelMock.mockReset();
    mocked.keyboardInitializeMock.mockReset();
    mocked.keyboardUpdateModelMock.mockReset();
    mocked.keyboardSendUpdateMock.mockReset();
  });

  it("shows inline keyboard with current assistant mode selected", async () => {
    mocked.getAssistantModeMock.mockReturnValue("agy");
    const replyMock = vi.fn().mockResolvedValue({ message_id: 1 });
    const ctx = {
      chat: { id: 42, type: "private" },
      message: { text: "/mode" },
      reply: replyMock,
    } as unknown as Context;

    await modeCommand(ctx as never);

    expect(replyMock).toHaveBeenCalledTimes(1);
    const [text, opts] = replyMock.mock.calls[0];
    expect(text).toBe(t("mode.prompt"));
    expect(opts.reply_markup.inline_keyboard[0][0].text).toContain(t("mode.option.opencode"));
    expect(opts.reply_markup.inline_keyboard[1][0].text).toContain("✅");
    expect(opts.reply_markup.inline_keyboard[1][0].text).toContain(t("mode.option.agy"));
    expect(opts.reply_markup.inline_keyboard[2][0].text).toContain(t("mode.option.cursor"));
  });
});

describe("bot/callbacks/mode-callback-handler", () => {
  beforeEach(() => {
    mocked.getAssistantModeMock.mockReset();
    mocked.getAssistantModeMock.mockReturnValue("opencode");
    mocked.getCurrentModelMock.mockReset();
    mocked.setAssistantModeMock.mockReset();
    mocked.selectModelMock.mockReset();
    mocked.keyboardInitializeMock.mockReset();
    mocked.keyboardUpdateModelMock.mockReset();
    mocked.keyboardSendUpdateMock.mockReset();
  });

  it("sets assistant mode and deletes menu message on callback", async () => {
    const deleteMessageMock = vi.fn().mockResolvedValue(undefined);
    const answerCbMock = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      chat: { id: 42, type: "private" },
      api: {},
      callbackQuery: { data: `${MODE_CALLBACK_PREFIX}agy` },
      deleteMessage: deleteMessageMock,
      answerCallbackQuery: answerCbMock,
    } as unknown as Context;

    const result = await handleModeCallback(ctx);

    expect(result).toBe(true);
    expect(mocked.setAssistantModeMock).toHaveBeenCalledWith("agy");
    expect(mocked.selectModelMock).toHaveBeenCalledWith({
      providerID: "antigravity",
      modelID: "gemini-3.5-flash-high",
      variant: "default",
    });
    expect(mocked.keyboardUpdateModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: "antigravity" }),
    );
    expect(mocked.keyboardSendUpdateMock).toHaveBeenCalledWith(42, true);
    expect(answerCbMock).toHaveBeenCalledWith({ text: t("mode.selected.agy") });
    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
  });

  it("selects Cursor with a compatible default model", async () => {
    const ctx = {
      chat: { id: 42, type: "private" },
      api: {},
      callbackQuery: { data: `${MODE_CALLBACK_PREFIX}cursor` },
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;

    await expect(handleModeCallback(ctx)).resolves.toBe(true);

    expect(mocked.setAssistantModeMock).toHaveBeenCalledWith("cursor");
    expect(mocked.selectModelMock).toHaveBeenCalledWith({
      providerID: "cursor",
      modelID: "auto",
      variant: "default",
    });
  });

  it("keeps the selected model when the active mode is selected again", async () => {
    mocked.getAssistantModeMock.mockReturnValue("cursor");
    mocked.getCurrentModelMock.mockReturnValue({
      providerID: "cursor",
      modelID: "cursor-grok-4.5-high",
      variant: "default",
    });
    const ctx = {
      chat: { id: 42, type: "private" },
      api: {},
      callbackQuery: { data: `${MODE_CALLBACK_PREFIX}cursor` },
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;

    await expect(handleModeCallback(ctx)).resolves.toBe(true);

    expect(mocked.setAssistantModeMock).not.toHaveBeenCalled();
    expect(mocked.selectModelMock).not.toHaveBeenCalled();
    expect(mocked.keyboardUpdateModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelID: "cursor-grok-4.5-high" }),
    );
  });

  it("rejects unknown callback prefix", async () => {
    const ctx = {
      callbackQuery: { data: "unknown:data" },
    } as unknown as Context;

    const result = await handleModeCallback(ctx);

    expect(result).toBe(false);
  });
});
