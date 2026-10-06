import { Context, InlineKeyboard } from "grammy";
import { getAssistantMode, type AssistantMode } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";

export const MODE_CALLBACK_PREFIX = "mode:";

export function buildAssistantModeKeyboard(current: AssistantMode): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `${current === "opencode" ? "✅ " : ""}${t("mode.option.opencode")}`,
      `${MODE_CALLBACK_PREFIX}opencode`,
    )
    .row()
    .text(`${current === "agy" ? "✅ " : ""}${t("mode.option.agy")}`, `${MODE_CALLBACK_PREFIX}agy`)
    .row()
    .text(
      `${current === "cursor" ? "✅ " : ""}${t("mode.option.cursor")}`,
      `${MODE_CALLBACK_PREFIX}cursor`,
    );
}

export async function modeCommand(ctx: Context): Promise<void> {
  const current = getAssistantMode();
  const keyboard = buildAssistantModeKeyboard(current);

  await ctx.reply(t("mode.prompt"), { reply_markup: keyboard });
}
