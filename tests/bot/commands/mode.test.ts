import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { MODE_CALLBACK_PREFIX, modeCommand } from "../../../src/bot/commands/mode-command.js";
import { handleModeCallback } from "../../../src/bot/callbacks/mode-callback-handler.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  getAssistantModeMock: vi.fn(),
  setAssistantModeMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getAssistantMode: mocked.getAssistantModeMock,
  setAssistantMode: mocked.setAssistantModeMock,
}));

describe("bot/commands/mode-command", () => {
  beforeEach(() => {
    mocked.getAssistantModeMock.mockReset();
    mocked.setAssistantModeMock.mockReset();
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
  });
});

describe("bot/callbacks/mode-callback-handler", () => {
  beforeEach(() => {
    mocked.getAssistantModeMock.mockReset();
    mocked.setAssistantModeMock.mockReset();
  });

  it("sets assistant mode and deletes menu message on callback", async () => {
    const deleteMessageMock = vi.fn().mockResolvedValue(undefined);
    const answerCbMock = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      callbackQuery: { data: `${MODE_CALLBACK_PREFIX}agy` },
      deleteMessage: deleteMessageMock,
      answerCallbackQuery: answerCbMock,
    } as unknown as Context;

    const result = await handleModeCallback(ctx);

    expect(result).toBe(true);
    expect(mocked.setAssistantModeMock).toHaveBeenCalledWith("agy");
    expect(answerCbMock).toHaveBeenCalledWith({ text: t("mode.selected.agy") });
    expect(deleteMessageMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown callback prefix", async () => {
    const ctx = {
      callbackQuery: { data: "unknown:data" },
    } as unknown as Context;

    const result = await handleModeCallback(ctx);

    expect(result).toBe(false);
  });
});
