import { constants } from "node:os";

const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "FetchError",
  "GrammyError",
  "HttpError",
  "APIError",
  "ProviderAuthError",
  "UnknownError",
  "MessageOutputLengthError",
  "MessageAbortedError",
  "StructuredOutputError",
  "ContextOverflowError",
  "ContentFilterError",
  "AgentRunAbortedError",
  "DurableAgyJobError",
  "DurableAgyJobAbortedError",
]);
const ERROR_CODES = new Set([
  ...Object.keys(constants.errno),
  "ENOTFOUND",
  "EAI_AGAIN",
  "ABORT_ERR",
  "ERR_INVALID_URL",
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
]);

export interface ErrorLogMetadata {
  name: string;
  statusCode?: number;
  code?: string;
  exitCode?: number;
  isRetryable?: boolean;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    // Do not run getters supplied by a remote error or inspect its payload.
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

/** Log protocol metadata, never messages, stacks, requests, responses or headers. */
export function getErrorLogMetadata(error: unknown): ErrorLogMetadata {
  let name = ownValue(error, "name");
  if (name === undefined && error && typeof error === "object") {
    try {
      name = ownValue(Object.getPrototypeOf(error), "name");
    } catch {
      // Revoked proxies and opaque objects must not break error handling.
    }
  }
  const metadata: ErrorLogMetadata = {
    name: typeof name === "string" && ERROR_NAMES.has(name) ? name : "UnknownError",
  };
  const data = ownValue(error, "data");
  const status =
    ownValue(error, "statusCode") ??
    ownValue(error, "status") ??
    ownValue(error, "error_code") ??
    ownValue(data, "statusCode");
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    metadata.statusCode = status;
  }
  const code = ownValue(error, "code") ?? ownValue(ownValue(error, "cause"), "code");
  if (typeof code === "string" && ERROR_CODES.has(code)) metadata.code = code;
  const exitCode = ownValue(error, "exitCode");
  if (
    typeof exitCode === "number" &&
    Number.isInteger(exitCode) &&
    exitCode >= 0 &&
    exitCode <= 255
  ) {
    metadata.exitCode = exitCode;
  }
  const retryable = ownValue(error, "isRetryable") ?? ownValue(data, "isRetryable");
  if (typeof retryable === "boolean") metadata.isRetryable = retryable;
  return metadata;
}
