import { Context, InlineKeyboard } from "grammy";
import { getFullModelCatalog } from "../../app/services/model-selection-service.js";
import type { FavoriteModel, ModelInfo } from "../../app/types/model.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { getAssistantMode } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "./inline-menu.js";

export const MODEL_CATALOG_CALLBACK = "model:catalog";
const PAGE_SIZE = 10;

export interface CatalogProvider {
  id: string;
  models: string[];
}

export function groupCatalogModels(models: FavoriteModel[]): CatalogProvider[] {
  const grouped = new Map<string, Set<string>>();
  for (const model of models) {
    const entries = grouped.get(model.providerID) ?? new Set<string>();
    entries.add(model.modelID);
    grouped.set(model.providerID, entries);
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entries]) => ({
      id,
      models: [...entries].sort((a, b) => a.localeCompare(b)),
    }));
}

export function buildCatalogPage(
  providers: CatalogProvider[],
  providerIndex: number | null,
  requestedPage: number,
): { text: string; keyboard: InlineKeyboard } {
  const provider = providerIndex === null ? null : providers[providerIndex];
  if (providerIndex !== null && !provider) {
    throw new Error("Invalid catalog provider");
  }
  const total = provider ? provider.models.length : providers.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (!Number.isInteger(requestedPage) || requestedPage < 0 || requestedPage >= pages) {
    throw new Error("Invalid catalog page");
  }
  const keyboard = new InlineKeyboard();
  const start = requestedPage * PAGE_SIZE;
  for (let index = start; index < Math.min(start + PAGE_SIZE, total); index++) {
    if (provider) {
      const name = provider.models[index];
      const label = name.length > 52 ? name.slice(0, 49) + "..." : name;
      keyboard.text(label, `${MODEL_CATALOG_CALLBACK}:select:${providerIndex}:${index}`).row();
    } else {
      const entry = providers[index];
      keyboard
        .text(`${entry.id} (${entry.models.length})`, `${MODEL_CATALOG_CALLBACK}:models:${index}:0`)
        .row();
    }
  }
  const pageCallback = (page: number) =>
    provider
      ? `${MODEL_CATALOG_CALLBACK}:models:${providerIndex}:${page}`
      : `${MODEL_CATALOG_CALLBACK}:providers:${page}`;
  if (requestedPage > 0)
    keyboard.text(t("model.catalog.previous"), pageCallback(requestedPage - 1));
  if (requestedPage + 1 < pages)
    keyboard.text(t("model.catalog.next"), pageCallback(requestedPage + 1));
  if (requestedPage > 0 || requestedPage + 1 < pages) keyboard.row();
  if (provider)
    keyboard
      .text(t("model.catalog.providers_button"), `${MODEL_CATALOG_CALLBACK}:providers:0`)
      .row();
  return {
    text: provider
      ? t("model.catalog.models", { provider: provider.id, total, page: requestedPage + 1, pages })
      : t("model.catalog.providers", {
          total,
          models: providers.reduce((n, entry) => n + entry.models.length, 0),
          page: requestedPage + 1,
          pages,
        }),
    keyboard: appendInlineMenuCancelButton(keyboard, "model"),
  };
}

// The catalog snapshot belongs to this exact menu message. Index callbacks stay short
// even for long model IDs and cannot select a different model after a cache refresh.
export async function handleModelCatalogCallback(ctx: Context): Promise<ModelInfo | null> {
  if (!(await ensureActiveInlineMenu(ctx, "model"))) return null;
  if (getAssistantMode() !== "opencode") {
    interactionManager.clear("model_catalog_mode_changed");
    await ctx
      .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
      .catch(() => {});
    return null;
  }
  const data = ctx.callbackQuery?.data ?? "";
  let providers = interactionManager.getSnapshot()?.metadata.modelCatalog as
    | CatalogProvider[]
    | undefined;
  if (data === MODEL_CATALOG_CALLBACK) {
    providers = groupCatalogModels(await getFullModelCatalog());
    if (!(await ensureActiveInlineMenu(ctx, "model"))) return null;
    if (getAssistantMode() !== "opencode") {
      interactionManager.clear("model_catalog_mode_changed");
      await ctx
        .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
        .catch(() => {});
      return null;
    }
    if (providers.length === 0) throw new Error("OpenCode returned an empty model catalog");
  }
  if (!Array.isArray(providers)) throw new Error("Catalog menu snapshot is unavailable");

  let providerIndex: number | null = null;
  let page = 0;
  const selected = /^model:catalog:select:(\d+):(\d+)$/.exec(data);
  if (selected) {
    const provider = providers[Number(selected[1])];
    const modelID = provider?.models[Number(selected[2])];
    if (!provider || !modelID) throw new Error("Invalid catalog model selection");
    return { providerID: provider.id, modelID, variant: "default" };
  }
  const modelsPage = /^model:catalog:models:(\d+):(\d+)$/.exec(data);
  const providersPage = /^model:catalog:providers:(\d+)$/.exec(data);
  if (modelsPage) {
    providerIndex = Number(modelsPage[1]);
    page = Number(modelsPage[2]);
  } else if (providersPage) {
    page = Number(providersPage[1]);
  } else if (data !== MODEL_CATALOG_CALLBACK) {
    throw new Error("Invalid catalog callback");
  }
  const rendered = buildCatalogPage(providers, providerIndex, page);
  try {
    await ctx.editMessageText(rendered.text, { reply_markup: rendered.keyboard });
  } catch (error) {
    const description = (error as { description?: unknown })?.description;
    const message =
      typeof description === "string" ? description : error instanceof Error ? error.message : "";
    if (!message.includes("message is not modified")) throw error;
  }
  interactionManager.transition({
    metadata: { ...interactionManager.getSnapshot()?.metadata, modelCatalog: providers },
  });
  await ctx.answerCallbackQuery().catch(() => {});
  return null;
}
