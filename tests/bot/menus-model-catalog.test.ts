import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { interactionManager } from "../../src/app/managers/interaction-manager.js";
const fake = vi.hoisted(() => ({ catalog: vi.fn(), active: vi.fn(), mode: vi.fn() }));
vi.mock("../../src/app/services/model-selection-service.js", () => ({
  getFullModelCatalog: fake.catalog,
}));
vi.mock("../../src/app/stores/settings-store.js", () => ({ getAssistantMode: fake.mode }));
vi.mock("../../src/bot/menus/inline-menu.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ensureActiveInlineMenu: fake.active,
}));
import {
  buildCatalogPage,
  groupCatalogModels,
  handleModelCatalogCallback,
} from "../../src/bot/menus/model-catalog-menu.js";

function context(data: string): Context {
  return {
    callbackQuery: { data },
    editMessageText: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue({}),
  } as unknown as Context;
}
function models() {
  return [
    ...Array.from({ length: 29 }, (_, n) => ({
      providerID: "opencode-go",
      modelID: n === 0 ? "deepseek-v4.1-flash" : `go-model-${n}`,
    })),
    { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    { providerID: "openrouter", modelID: "long-" + "x".repeat(100) },
  ];
}

describe("complete model catalog menu", () => {
  beforeEach(() => {
    interactionManager.clear("test");
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { menuKind: "model", messageId: 1 },
    });
    fake.catalog.mockReset();
    fake.catalog.mockResolvedValue(models());
    fake.active.mockResolvedValue(true);
    fake.mode.mockReturnValue("opencode");
  });
  it("groups every Go model without a search limit or duplicates", () => {
    const providers = groupCatalogModels([...models(), models()[0]]);
    expect(providers.find((p) => p.id === "opencode-go")?.models).toHaveLength(29);
    expect(providers.reduce((total, p) => total + p.models.length, 0)).toBe(31);
  });
  it("reaches all models over bounded pages and keeps long-ID callbacks short", () => {
    const providers = groupCatalogModels(models());
    const go = providers.findIndex((p) => p.id === "opencode-go");
    const callbacks = [0, 1, 2].flatMap((page) =>
      buildCatalogPage(providers, go, page)
        .keyboard.inline_keyboard.flat()
        .filter((b) => b.callback_data?.includes(":select:"))
        .map((b) => b.callback_data),
    );
    expect(new Set(callbacks).size).toBe(29);
    const long = buildCatalogPage(
      providers,
      providers.findIndex((p) => p.id === "openrouter"),
      0,
    ).keyboard.inline_keyboard.flat();
    expect(long.every((b) => Buffer.byteLength(b.callback_data ?? "") <= 64)).toBe(true);
    expect(() => buildCatalogPage(providers, go, 3)).toThrow();
  });
  it("selects the exact long model ID from the current menu snapshot", async () => {
    await handleModelCatalogCallback(context("model:catalog"));
    const catalog = interactionManager.getSnapshot()?.metadata.modelCatalog as ReturnType<
      typeof groupCatalogModels
    >;
    const index = catalog.findIndex((p) => p.id === "openrouter");
    fake.catalog.mockResolvedValue([]);
    expect(await handleModelCatalogCallback(context(`model:catalog:select:${index}:0`))).toEqual({
      providerID: "openrouter",
      modelID: "long-" + "x".repeat(100),
      variant: "default",
    });
    expect(fake.catalog).toHaveBeenCalledTimes(1);
  });
  it("rejects stale menus and unsupported indices without selecting anything", async () => {
    fake.active.mockResolvedValueOnce(false);
    expect(await handleModelCatalogCallback(context("model:catalog"))).toBeNull();
    expect(fake.catalog).not.toHaveBeenCalled();
    await handleModelCatalogCallback(context("model:catalog"));
    await expect(
      handleModelCatalogCallback(context("model:catalog:select:999:0")),
    ).rejects.toThrow();
  });
  it("keeps a repeated unchanged page active and acknowledges its callback", async () => {
    const ctx = context("model:catalog");
    vi.mocked(ctx.editMessageText).mockRejectedValueOnce({
      description: "Bad Request: message is not modified",
    });
    expect(await handleModelCatalogCallback(ctx)).toBeNull();
    expect(interactionManager.getSnapshot()?.metadata.modelCatalog).toBeDefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
  it("does not render a menu replaced while its API lookup was pending", async () => {
    fake.active.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const ctx = context("model:catalog");
    expect(await handleModelCatalogCallback(ctx)).toBeNull();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("does not reuse this OpenCode catalog after switching to AGY", async () => {
    fake.mode.mockReturnValue("agy");
    const ctx = context("model:catalog");
    expect(await handleModelCatalogCallback(ctx)).toBeNull();
    expect(fake.catalog).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(interactionManager.getSnapshot()).toBeNull();
  });
});
