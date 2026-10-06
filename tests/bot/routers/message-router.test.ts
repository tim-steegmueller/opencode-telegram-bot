import { describe, expect, it, vi } from "vitest";
import { registerMessageRouter } from "../../../src/bot/routers/message-router.js";
import type { Context } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { logger } from "../../../src/utils/logger.js";
import { t } from "../../../src/i18n/index.js";

describe("bot/routers/message-router", () => {
  it("registers reply keyboard, media, and text routes", () => {
    const bot = {
      on: vi.fn(),
      hears: vi.fn(),
    };

    registerMessageRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      setTelegramContext: vi.fn(),
    });

    expect(bot.hears).toHaveBeenCalledTimes(5);
    expect(bot.on.mock.calls.map(([event]) => event)).toEqual([
      "message:text",
      "message:text",
      "message:voice",
      "message:audio",
      "message:video",
      "message:video_note",
      "message",
      "message:photo",
      "message:document",
      "message:text",
    ]);
  });

  it.each([
    [1, "🤖 synthetic-private-prompt Agent", "Agent"],
    [2, "🤖 synthetic-private-prompt", "Model"],
    [3, "📊 synthetic-private-prompt", "Context"],
    [4, "💡 synthetic-private-prompt", "Variant"],
  ] as const)("does not log user-supplied %s menu text", async (index, text, menu) => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(interactionManager, "getSnapshot").mockReturnValue({
      kind: "task",
      expectedInput: "text",
    } as ReturnType<typeof interactionManager.getSnapshot>);
    const bot = { on: vi.fn(), hears: vi.fn() };
    registerMessageRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      setTelegramContext: vi.fn(),
    });
    const [pattern, handler] = bot.hears.mock.calls[index];
    expect(pattern.test(text)).toBe(true);
    const reply = vi.fn().mockResolvedValue({ message_id: 1 });

    await handler({ message: { text }, reply } as unknown as Context);

    expect(debug).toHaveBeenCalledWith(`[Bot] ${menu} button pressed`);
    expect(JSON.stringify(debug.mock.calls)).not.toContain("synthetic-");
    expect(reply).toHaveBeenCalledWith(t("interaction.blocked.finish_current"));
  });

  it.each(["/new synthetic-private-argument", "synthetic-private-prompt"])(
    "logs only message kind and size for %s",
    async (text) => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const bot = { on: vi.fn(), hears: vi.fn() };
      registerMessageRouter(bot as never, {
        ensureEventSubscription: vi.fn(),
        setTelegramContext: vi.fn(),
      });
      const [, handler] = bot.on.mock.calls.filter(([event]) => event === "message:text")[1];
      const next = vi.fn().mockResolvedValue(undefined);

      await handler({ message: { text }, chat: { id: 777 } } as unknown as Context, next);

      expect(debug).toHaveBeenCalledWith(
        `[Bot] Received text message: ${text.startsWith("/") ? "command" : "prompt"} (length=${text.length}), chatId=777`,
      );
      expect(JSON.stringify(debug.mock.calls)).not.toContain("synthetic-");
      expect(next).toHaveBeenCalledTimes(1);
    },
  );
});
