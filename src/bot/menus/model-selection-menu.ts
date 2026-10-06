import { MODEL_CATALOG_CALLBACK } from "./model-catalog-menu.js";
import { Context, InlineKeyboard } from "grammy";
import {
  fetchCurrentModel,
  getModelSelectionLists,
} from "../../app/services/model-selection-service.js";
import type { FavoriteModel, ModelInfo, ModelSelectionLists } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";
import { getAssistantMode } from "../../app/stores/settings-store.js";
import { listCursorModels } from "../../app/services/cursor-agent-service.js";
import { listAgyModels } from "../../app/services/agy-model-service.js";

export const MODEL_SEARCH_CALLBACK = "model:search";
export const MODEL_SEARCH_AGAIN_CALLBACK = "model:search:again";
export const MODEL_SEARCH_CANCEL_CALLBACK = "model:search:cancel";
export const MODEL_LIST_CALLBACK_PREFIX = "model:list:";

type ModelListKind = "favorites" | "recent";

export function buildModelListCallback(kind: ModelListKind, index: number): string {
  return `${MODEL_LIST_CALLBACK_PREFIX}${kind}:${index}`;
}

const CURSOR_FAVORITE_MODEL_IDS = [
  "auto",
  "gpt-5.6-sol-high",
  "claude-opus-4-8-thinking-high",
  "composer-2.5",
  "gemini-3.5-flash",
  "kimi-k2.7-code",
  "glm-5.2-high",
];

export async function buildAgyModelSelectionMenu(
  currentModel?: ModelInfo,
): Promise<InlineKeyboard> {
  const models = await listAgyModels();
  const keyboard = new InlineKeyboard().text(t("model.search.button"), MODEL_SEARCH_CALLBACK).row();
  for (const [index, model] of models.entries()) {
    const isActive =
      currentModel?.providerID === model.providerID && currentModel.modelID === model.modelID;
    const label = `${isActive ? "✅ " : ""}${model.modelID}`;
    keyboard.text(label, `model:${model.providerID}:${model.modelID}`);
    if (index < models.length - 1) {
      keyboard.row();
    }
  }

  return keyboard;
}

export async function buildCursorModelSelectionMenu(
  currentModel?: ModelInfo,
): Promise<InlineKeyboard> {
  const availableModels = await listCursorModels();
  const availableById = new Map(availableModels.map((model) => [model.modelID, model]));
  const featured = CURSOR_FAVORITE_MODEL_IDS.map((id) => availableById.get(id)).filter(
    (model): model is NonNullable<typeof model> => Boolean(model),
  );
  const keyboard = new InlineKeyboard().text(t("model.search.button"), MODEL_SEARCH_CALLBACK).row();
  for (const model of featured) {
    const isActive =
      currentModel?.providerID === "cursor" && currentModel.modelID === model.modelID;
    keyboard
      .text(`${isActive ? "✅ " : ""}${model.displayName}`, `model:cursor:${model.modelID}`)
      .row();
  }
  return keyboard;
}

function buildModelSelectionMenuText(modelLists: ModelSelectionLists): string {
  const lines = [t("model.menu.select"), t("model.menu.favorites_title")];

  if (modelLists.favorites.length === 0) {
    lines.push(t("model.menu.favorites_empty"));
  }

  lines.push(t("model.menu.recent_title"));

  if (modelLists.recent.length === 0) {
    lines.push(t("model.menu.recent_empty"));
  }

  return lines.join("\n");
}

/**
 * Build inline keyboard with favorite and recent models, plus a search button at the top.
 */
export async function buildModelSelectionMenu(
  currentModel?: ModelInfo,
  modelLists?: ModelSelectionLists,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const lists = modelLists ?? (await getModelSelectionLists());
  const favorites = lists.favorites;
  const recent = lists.recent;

  // Search button — always present as first row
  keyboard.text(t("model.search.button"), MODEL_SEARCH_CALLBACK).row();
  keyboard.text(t("model.catalog.button"), MODEL_CATALOG_CALLBACK).row();

  if (favorites.length === 0 && recent.length === 0) {
    logger.warn("[ModelHandler] No model choices found in favorites/recent");
    return keyboard;
  }

  const addButton = (
    model: FavoriteModel,
    prefix: string,
    kind: ModelListKind,
    index: number,
  ): void => {
    const isActive =
      currentModel &&
      model.providerID === currentModel.providerID &&
      model.modelID === currentModel.modelID;

    const label = `${prefix} ${model.providerID}/${model.modelID}`;
    const labelWithCheck = isActive ? `✅ ${label}` : label;

    keyboard.text(labelWithCheck, buildModelListCallback(kind, index)).row();
  };

  favorites.forEach((model, index) => addButton(model, "⭐", "favorites", index));
  recent.forEach((model, index) => addButton(model, "🕘", "recent", index));

  return keyboard;
}

/**
 * Show model selection menu
 */
export async function showModelSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentModel = fetchCurrentModel();
    if (getAssistantMode() === "agy") {
      await replyWithInlineMenu(ctx, {
        menuKind: "model",
        text: t("model.menu.select"),
        keyboard: await buildAgyModelSelectionMenu(currentModel),
      });
      return;
    }

    if (getAssistantMode() === "cursor") {
      await replyWithInlineMenu(ctx, {
        menuKind: "model",
        text: t("model.menu.select"),
        keyboard: await buildCursorModelSelectionMenu(currentModel),
      });
      return;
    }

    const modelLists = await getModelSelectionLists();
    const keyboard = await buildModelSelectionMenu(currentModel, modelLists);

    // keyboard always has at least the search button, so length > 0
    const text = buildModelSelectionMenuText(modelLists);

    await replyWithInlineMenu(ctx, {
      menuKind: "model",
      text,
      keyboard,
      metadata: { modelLists },
    });
  } catch (err) {
    logger.error("[ModelHandler] Error showing model menu:", err);
    await ctx.reply(t("model.menu.error"));
  }
}
