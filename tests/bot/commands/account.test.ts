import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { resetRuntimeLocale, setRuntimeLocale } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  listAgyAccountsMock: vi.fn(),
  getAgyAccountMock: vi.fn(),
  setAgyAccountMock: vi.fn(),
}));

vi.mock("../../../src/app/services/agy-account-service.js", () => ({
  listAgyAccounts: mocked.listAgyAccountsMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getAgyAccount: mocked.getAgyAccountMock,
  setAgyAccount: mocked.setAgyAccountMock,
}));

import { accountCommand } from "../../../src/bot/commands/account-command.js";
import { handleAccountCallback } from "../../../src/bot/callbacks/account-callback-handler.js";

describe("bot/commands/account", () => {
  beforeEach(() => {
    setRuntimeLocale("de");
    vi.clearAllMocks();
    mocked.getAgyAccountMock.mockReturnValue("google-2");
    mocked.listAgyAccountsMock.mockResolvedValue([
      { alias: "default", homeDirectory: "/home/tim", isDefault: true },
      { alias: "google-2", homeDirectory: "/accounts/google-2/home", isDefault: false },
    ]);
  });

  afterEach(resetRuntimeLocale);

  it("shows configured account aliases and marks the current one", async () => {
    const ctx = { reply: vi.fn() } as unknown as Context;

    await accountCommand(ctx as never);

    const keyboard = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.reply_markup;
    expect(keyboard.inline_keyboard[1][0]).toMatchObject({
      text: "✅ google-2",
      callback_data: "account:google-2",
    });
  });

  it("stores a valid account selected from the current profile list", async () => {
    const ctx = {
      callbackQuery: { data: "account:google-2" },
      answerCallbackQuery: vi.fn(),
      deleteMessage: vi.fn(),
    } as unknown as Context;

    expect(await handleAccountCallback(ctx)).toBe(true);
    expect(mocked.setAgyAccountMock).toHaveBeenCalledWith("google-2");
  });

  it("rejects a stale account callback without changing settings", async () => {
    const ctx = {
      callbackQuery: { data: "account:missing" },
      answerCallbackQuery: vi.fn(),
    } as unknown as Context;

    expect(await handleAccountCallback(ctx)).toBe(true);
    expect(mocked.setAgyAccountMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it("shows Chrome account names and marks profiles that still need AGY sign-in", async () => {
    mocked.listAgyAccountsMock.mockResolvedValue([
      { alias: "google-abc", displayName: "alex@example.com", requiresLogin: true },
    ]);
    const ctx = { reply: vi.fn() } as unknown as Context;

    await accountCommand(ctx as never);

    const keyboard = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.reply_markup;
    expect(keyboard.inline_keyboard[0][0].text).toContain("alex@example.com");
    expect(keyboard.inline_keyboard[0][0].text).toContain("Anmeldung nötig");
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe("account:google-abc");
  });

  it("does not select an imported Chrome account without its own AGY sign-in", async () => {
    mocked.listAgyAccountsMock.mockResolvedValue([
      { alias: "google-abc", displayName: "alex@example.com", requiresLogin: true },
    ]);
    const ctx = {
      callbackQuery: { data: "account:google-abc" },
      answerCallbackQuery: vi.fn(),
      deleteMessage: vi.fn(),
    } as unknown as Context;

    expect(await handleAccountCallback(ctx)).toBe(true);
    expect(mocked.setAgyAccountMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
  });
});
