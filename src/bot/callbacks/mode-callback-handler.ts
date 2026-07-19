import { Context } from "grammy";
import { setAssistantMode, type AssistantMode } from "../../app/stores/settings-store.js";
import { MODE_CALLBACK_PREFIX } from "../commands/mode-command.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

const ASSISTANT_MODES: AssistantMode[] = ["opencode", "agy"];

export async function handleModeCallback(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || !callbackQuery.data.startsWith(MODE_CALLBACK_PREFIX)) {
    return false;
  }

  const mode = callbackQuery.data.slice(MODE_CALLBACK_PREFIX.length) as AssistantMode;

  if (!ASSISTANT_MODES.includes(mode)) {
    return false;
  }

  setAssistantMode(mode);

  await ctx.answerCallbackQuery({
    text: mode === "agy" ? t("mode.selected.agy") : t("mode.selected.opencode"),
  });

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
