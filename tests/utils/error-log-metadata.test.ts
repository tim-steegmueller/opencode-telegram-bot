import { describe, expect, it, vi } from "vitest";
import { getErrorLogMetadata } from "../../src/utils/error-log-metadata.js";

describe("getErrorLogMetadata", () => {
  it("keeps only bounded protocol metadata from SDK errors", () => {
    const error = {
      name: "APIError",
      data: {
        statusCode: 429,
        isRetryable: true,
        message: "synthetic-private-prompt",
        responseBody: "synthetic-private-response",
        responseHeaders: { authorization: "synthetic-token" },
      },
      request: { body: "synthetic-private-request" },
    };
    expect(getErrorLogMetadata(error)).toEqual({
      name: "APIError",
      statusCode: 429,
      isRetryable: true,
    });
  });

  it("preserves native error class, system code and exit status", () => {
    const error = Object.assign(new TypeError("synthetic-private-prompt"), {
      code: "ECONNRESET",
      exitCode: 1,
    });
    expect(getErrorLogMetadata(error)).toEqual({
      name: "TypeError",
      code: "ECONNRESET",
      exitCode: 1,
    });
    expect(error.message).toBe("synthetic-private-prompt");
  });

  it("retains a known immediate cause code without exposing the cause", () => {
    const cause = Object.assign(new Error("synthetic-private-prompt"), { code: "EAI_AGAIN" });
    expect(getErrorLogMetadata(new Error("synthetic-token", { cause }))).toEqual({
      name: "Error",
      code: "EAI_AGAIN",
    });
  });

  it.each([null, undefined, "synthetic-secret", 42, { message: "synthetic-secret" }])(
    "never serializes an unknown thrown value: %j",
    (error) => {
      expect(getErrorLogMetadata(error)).toEqual({ name: "UnknownError" });
    },
  );

  it("does not serialize cyclic objects or run getters", () => {
    const getter = vi.fn(() => {
      throw new Error("synthetic-secret");
    });
    const error: Record<string, unknown> = {};
    error.self = error;
    for (const key of [
      "name",
      "data",
      "statusCode",
      "status",
      "error_code",
      "code",
      "cause",
      "exitCode",
      "isRetryable",
    ]) {
      Object.defineProperty(error, key, { get: getter });
    }
    expect(getErrorLogMetadata(error)).toEqual({ name: "UnknownError" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts revoked proxies without masking the original failure", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(getErrorLogMetadata(proxy)).toEqual({ name: "UnknownError" });
  });

  it("rejects free-form names and codes and invalid protocol values", () => {
    expect(
      getErrorLogMetadata({
        name: "synthetic-secret",
        code: "synthetic-secret",
        statusCode: 999,
        exitCode: Infinity,
        isRetryable: "synthetic-secret",
      }),
    ).toEqual({ name: "UnknownError" });
  });

  it("retains false retryability and Telegram HTTP status", () => {
    expect(
      getErrorLogMetadata({ name: "GrammyError", error_code: 403, isRetryable: false }),
    ).toEqual({
      name: "GrammyError",
      statusCode: 403,
      isRetryable: false,
    });
  });
});
