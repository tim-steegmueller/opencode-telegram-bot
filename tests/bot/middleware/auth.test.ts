import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { allowedUserId: 42, token: "test", proxyUrl: "" },
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
      model: { provider: "test", modelId: "test" },
    },
    server: { logLevel: "error" },
    bot: {},
    files: { maxFileSizeKb: 100 },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { authMiddleware } from "../../../src/bot/middleware/auth.js";

describe("bot/middleware/auth", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined) as NextFunction;
  });

  it("allows the configured user in a private chat", async () => {
    const ctx = {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
    } as Context;

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects the configured user in a group chat", async () => {
    const ctx = {
      from: { id: 42 },
      chat: { id: -100123, type: "supergroup" },
      api: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Context;

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });
});
