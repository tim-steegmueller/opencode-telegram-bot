import { Context, InlineKeyboard } from "grammy";
import {
  fetchCurrentModel,
  getModelSelectionLists,
} from "../../app/services/model-selection-service.js";
import type {
  FavoriteModel,
  ModelInfo,
  ModelSelectionLists,
} from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";
import { getAssistantMode } from "../../app/stores/settings-store.js";

export const MODEL_SEARCH_CALLBACK = "model:search";
export const MODEL_SEARCH_AGAIN_CALLBACK = "model:search:again";
export const MODEL_SEARCH_CANCEL_CALLBACK = "model:search:cancel";

const AGY_MODELS: FavoriteModel[] = [
  { providerID: "antigravity", modelID: "gemini-3.5-flash-high" },
  { providerID: "antigravity", modelID: "gemini-3.5-flash-medium" },
  { providerID: "antigravity", modelID: "gemini-3.1-pro-high" },
  { providerID: "antigravity", modelID: "gemini-3.1-pro-low" },
  { providerID: "antigravity", modelID: "claude-sonnet-4.6" },
  { providerID: "antigravity", modelID: "claude-opus-4.6" },
  { providerID: "antigravity", modelID: "gpt-oss-120b" },
];

export function buildAgyModelSelectionMenu(currentModel?: ModelInfo): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, model] of AGY_MODELS.entries()) {
    const isActive =
      currentModel?.providerID === model.providerID && currentModel.modelID === model.modelID;
    const label = `${isActive ? "✅ " : ""}${model.modelID}`;
    keyboard.text(label, `model:${model.providerID}:${model.modelID}`);
    if (index < AGY_MODELS.length - 1) {
      keyboard.row();
    }
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

  if (favorites.length === 0 && recent.length === 0) {
    logger.warn("[ModelHandler] No model choices found in favorites/recent");
    return keyboard;
  }

  const addButton = (model: FavoriteModel, prefix: string): void => {
    const isActive =
      currentModel &&
      model.providerID === currentModel.providerID &&
      model.modelID === currentModel.modelID;

    const label = `${prefix} ${model.providerID}/${model.modelID}`;
    const labelWithCheck = isActive ? `✅ ${label}` : label;

    keyboard.text(labelWithCheck, `model:${model.providerID}:${model.modelID}`).row();
  };

  favorites.forEach((model) => addButton(model, "⭐"));
  recent.forEach((model) => addButton(model, "🕘"));

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
        keyboard: buildAgyModelSelectionMenu(currentModel),
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
    });
  } catch (err) {
    logger.error("[ModelHandler] Error showing model menu:", err);
    await ctx.reply(t("model.menu.error"));
  }
}
