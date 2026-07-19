import { Context } from "grammy";
import { listAgyAccounts } from "../../app/services/agy-account-service.js";
import { setAgyAccount } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { ACCOUNT_CALLBACK_PREFIX } from "../commands/account-command.js";

export async function handleAccountCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(ACCOUNT_CALLBACK_PREFIX)) {
    return false;
  }

  const alias = data.slice(ACCOUNT_CALLBACK_PREFIX.length);
  const account = (await listAgyAccounts()).find((profile) => profile.alias === alias);
  if (!account) {
    await ctx.answerCallbackQuery({ text: t("account.unavailable") });
    return true;
  }

  setAgyAccount(account.alias);
  await ctx.answerCallbackQuery({ text: t("account.selected", { account: account.alias }) });
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn("[Account] Failed to delete account selection message", error);
    await ctx.editMessageReplyMarkup().catch(() => {});
  }

  return true;
}
