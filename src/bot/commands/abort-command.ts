import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { clearPromptResponseMode } from "../handlers/prompt.js";
import { markUserAbortRequested } from "../../app/managers/abort-suppression-manager.js";
import { isAgyAgentRunActive } from "../../app/services/agy-agent-service.js";
import { isCursorAgentRunActive } from "../../app/services/cursor-agent-service.js";
import { abortActiveAgentRun } from "../../app/services/agent-run-service.js";
import { abortActiveAgyJob } from "../../app/services/agy-job-service.js";

type SessionState = "idle" | "busy" | "not-found";

interface AbortCurrentOperationOptions {
  notifyUser?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortLocalStreaming(): void {
  clearAllInteractionState("abort_command");
}

async function releaseAbortBusyState(sessionId: string, reason: string): Promise<void> {
  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, reason);
  await markAttachedSessionIdle(sessionId);
  clearPromptResponseMode(sessionId);
}

async function pollSessionStatus(
  sessionId: string,
  directory: string,
  maxWaitMs: number = 5000,
): Promise<SessionState> {
  const startedAt = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const { data, error } = await opencodeClient.session.status({ directory });

      if (error || !data) {
        break;
      }

      const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
      if (!sessionStatus) {
        return "not-found";
      }

      if (sessionStatus.type === "idle" || sessionStatus.type === "error") {
        return "idle";
      }

      if (sessionStatus.type !== "busy") {
        return "not-found";
      }

      await sleep(pollIntervalMs);
    } catch (error) {
      logger.warn("[Abort] Failed to poll session status:", error);
      break;
    }
  }

  return "busy";
}

export async function abortCurrentOperation(
  ctx: Context,
  options: AbortCurrentOperationOptions = {},
): Promise<boolean> {
  const notifyUser = options.notifyUser ?? true;

  try {
    abortLocalStreaming();

    // Engine changes affect future jobs, not the running job that /abort must stop.
    const externalAgentActive = isAgyAgentRunActive() || isCursorAgentRunActive();
    if (externalAgentActive) {
      const stop = (abortActiveAgentRun() ?? abortActiveAgyJob()).catch((error) => {
        logger.error("[Abort] External agent stop failed:", error);
        return false;
      });
      if (!notifyUser) return await stop;

      const waitingMessage = await ctx.reply(t("stop.in_progress"));
      const chatId = ctx.chat?.id;
      const stopped = await stop;
      if (!chatId) {
        logger.warn("[Abort] Chat context is missing while aborting external agent");
        return stopped;
      }
      await ctx.api.editMessageText(
        chatId,
        waitingMessage.message_id,
        stopped ? t("stop.success") : t("stop.warn_unconfirmed"),
      );
      return stopped;
    }

    const currentSession = getCurrentSession();

    if (!currentSession) {
      if (notifyUser) {
        await ctx.reply(t("stop.no_active_session"));
      }
      return true;
    }

    let waitingMessageId: number | null = null;
    let chatId: number | null = null;

    if (notifyUser) {
      const waitingMessage = await ctx.reply(t("stop.in_progress"));
      waitingMessageId = waitingMessage.message_id;
      chatId = ctx.chat?.id ?? null;

      if (!chatId) {
        logger.warn("[Abort] Chat context is missing while aborting active session");
        return false;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    markUserAbortRequested(currentSession.id);

    try {
      const { data: abortResult, error: abortError } = await opencodeClient.session.abort(
        {
          sessionID: currentSession.id,
          directory: currentSession.directory,
        },
        { signal: controller.signal },
      );

      clearTimeout(timeoutId);

      if (abortError) {
        logger.warn("[Abort] Abort request failed:", abortError);
        await releaseAbortBusyState(currentSession.id, "abort_unconfirmed");
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_unconfirmed"));
        }
        return false;
      }

      if (abortResult !== true) {
        await releaseAbortBusyState(currentSession.id, "abort_maybe_finished");
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_maybe_finished"));
        }
        return false;
      }

      const finalStatus = await pollSessionStatus(
        currentSession.id,
        currentSession.directory,
        5000,
      );

      if (finalStatus === "idle" || finalStatus === "not-found") {
        await releaseAbortBusyState(currentSession.id, "abort_confirmed");
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.success"));
        }
        return true;
      } else {
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_still_busy"));
        }
        return false;
      }
    } catch (error) {
      clearTimeout(timeoutId);
      await releaseAbortBusyState(currentSession.id, "abort_error");

      if (error instanceof Error && error.name === "AbortError") {
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_timeout"));
        }
      } else {
        logger.error("[Abort] Error while aborting session:", error);
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_local_only"));
        }
      }
      return false;
    }
  } catch (error) {
    logger.error("[Abort] Unexpected error:", error);
    if (notifyUser) await ctx.reply(t("stop.error"));
    return false;
  }
}

export async function abortCommand(ctx: CommandContext<Context>): Promise<void> {
  await abortCurrentOperation(ctx);
}
