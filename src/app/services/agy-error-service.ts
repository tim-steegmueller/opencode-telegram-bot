import { t } from "../../i18n/index.js";
import type { I18nKey } from "../../i18n/en.js";

export function formatAgyFailure(error: unknown, modelName: string, seconds: number): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = message.slice(-128 * 1024);
  let details: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const match = /^AGY_ERROR:\s*(\{.*\})\s*$/.exec(line.trim());
    if (!match) continue;
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      // Only complete, structured CLI errors may contribute public diagnostics.
    }
  }

  const code = typeof details.error_code === "number" ? details.error_code : null;
  const status = details.status;
  let reason: I18nKey = "agy.failure.unknown";
  if (code === 429 || status === "RESOURCE_EXHAUSTED") {
    reason = "agy.failure.quota";
  } else if (
    code === 401 ||
    code === 403 ||
    status === "UNAUTHENTICATED" ||
    status === "PERMISSION_DENIED"
  ) {
    reason = "agy.failure.auth";
  } else if (
    status === "DEADLINE_EXCEEDED" ||
    /AGY timed out after \d+ms|timeout waiting for response/.test(text)
  ) {
    reason = "agy.failure.timeout";
  } else if (code === 503 || status === "UNAVAILABLE") {
    reason = "agy.failure.unavailable";
  }

  const lines = [
    t("agy.failed_status"),
    t(reason),
    t("agy.failure.context", {
      model: modelName,
      seconds: Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0,
    }),
  ];
  if (code !== null && Number.isInteger(code) && code >= 400 && code <= 599) {
    lines.push(`HTTP ${code}`);
  }
  if (reason === "agy.failure.quota" && typeof details.short_error === "string") {
    const reset = /\bResets in ((?:\d{1,5}h)?(?:\d{1,2}m)?(?:\d{1,2}s)?)\./.exec(
      details.short_error,
    );
    if (reset?.[1]) lines.push(t("agy.failure.reset", { duration: reset[1] }));
  }
  if (typeof details.error_id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(details.error_id)) {
    lines.push(t("agy.failure.reference", { id: details.error_id }));
  }
  lines.push(t("agy.failure.no_retry"));
  return lines.join("\n");
}
