import { CommandContext, Context, InlineKeyboard } from "grammy";
import { listAgyAccounts } from "../../app/services/agy-account-service.js";
import { getAgyAccount } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";

export const ACCOUNT_CALLBACK_PREFIX = "account:";

export async function accountCommand(ctx: CommandContext<Context>): Promise<void> {
  const current = getAgyAccount();
  const accounts = await listAgyAccounts();
  const keyboard = new InlineKeyboard();

  for (const [index, account] of accounts.entries()) {
    const label = `${account.alias === current ? "✅ " : ""}${account.alias}`;
    keyboard.text(label, `${ACCOUNT_CALLBACK_PREFIX}${account.alias}`);
    if (index < accounts.length - 1) {
      keyboard.row();
    }
  }

  await ctx.reply(t("account.prompt"), { reply_markup: keyboard });
}
