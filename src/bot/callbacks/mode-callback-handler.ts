import { Context } from "grammy";
import {
  getAssistantMode,
  getCurrentModel,
  setAssistantMode,
  type AssistantMode,
} from "../../app/stores/settings-store.js";
import type { ModelInfo } from "../../app/types/model.js";
import { MODE_CALLBACK_PREFIX } from "../commands/mode-command.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { selectModel } from "../../app/services/model-selection-service.js";
import { config } from "../../config.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";

const ASSISTANT_MODES: AssistantMode[] = ["opencode", "agy", "cursor"];

function getDefaultModel(mode: AssistantMode) {
  if (mode === "agy") {
    return { providerID: "antigravity", modelID: "gemini-3.5-flash-high", variant: "default" };
  }
  if (mode === "cursor") {
    return { providerID: "cursor", modelID: "auto", variant: "default" };
  }
  return {
    providerID: config.opencode.model.provider,
    modelID: config.opencode.model.modelId,
    variant: "default",
  };
}

function isModelCompatible(mode: AssistantMode, model: ModelInfo | undefined): model is ModelInfo {
  if (!model?.modelID) {
    return false;
  }
  if (mode === "agy") {
    return model.providerID === "antigravity";
  }
  if (mode === "cursor") {
    return model.providerID === "cursor";
  }
  return model.providerID !== "antigravity" && model.providerID !== "cursor";
}

export async function handleModeCallback(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || !callbackQuery.data.startsWith(MODE_CALLBACK_PREFIX)) {
    return false;
  }

  const mode = callbackQuery.data.slice(MODE_CALLBACK_PREFIX.length) as AssistantMode;

  if (!ASSISTANT_MODES.includes(mode)) {
    return false;
  }

  const currentMode = getAssistantMode();
  const currentModel = getCurrentModel();
  const keepCurrentModel = currentMode === mode && isModelCompatible(mode, currentModel);
  const selectedModel = keepCurrentModel ? currentModel : getDefaultModel(mode);

  if (currentMode !== mode) {
    setAssistantMode(mode);
  }
  if (!keepCurrentModel) {
    selectModel(selectedModel);
  }

  await ctx.answerCallbackQuery({
    text:
      mode === "agy"
        ? t("mode.selected.agy")
        : mode === "cursor"
          ? t("mode.selected.cursor")
          : t("mode.selected.opencode"),
  });
  if (ctx.chat) {
    keyboardManager.initialize(ctx.api, ctx.chat.id);
    keyboardManager.updateModel(selectedModel);
    await keyboardManager.sendKeyboardUpdate(ctx.chat.id, true);
  }

  try {
    await ctx.deleteMessage();
  } catch (deleteError) {
    logger.warn("[Mode] Failed to delete mode selection message:", deleteError);

    try {
      await ctx.editMessageReplyMarkup();
    } catch (editError) {
      logger.warn("[Mode] Failed to remove mode selection keyboard:", editError);
    }
  }

  return true;
}
