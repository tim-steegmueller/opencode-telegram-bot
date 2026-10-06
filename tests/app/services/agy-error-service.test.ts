import { afterEach, describe, expect, it } from "vitest";
import { formatAgyFailure } from "../../../src/app/services/agy-error-service.js";
import { resetRuntimeLocale, setRuntimeLocale } from "../../../src/i18n/index.js";

const cliError = (details: Record<string, unknown>): Error =>
  new Error(`AGY exited with code 3 signal null\nAGY_ERROR: ${JSON.stringify(details)}`);

describe("safe AGY failure diagnostics", () => {
  afterEach(() => resetRuntimeLocale());

  it("reports quota, recorded reset interval, model, duration and safe reference in German", () => {
    setRuntimeLocale("de");
    const output = formatAgyFailure(
      cliError({
        status: "RESOURCE_EXHAUSTED",
        error_code: 429,
        retryable: true,
        short_error: "Individual quota reached. Resets in 136h25m44s. synthetic-private-detail",
        error_id: "6ad905ed-2d0f-4d90-a6fb-a4fe8ebc8a75-2",
      }),
      "Claude Sonnet 5.5 (High)",
      4.9,
    );
    expect(output).toContain("Kontingent");
    expect(output).toContain("HTTP 429");
    expect(output).toContain("136h25m44s");
    expect(output).toContain("Modell: Claude Sonnet 5.5 (High) | Dauer: 5s");
    expect(output).toContain("Fehlerreferenz: 6ad905ed-2d0f-4d90-a6fb-a4fe8ebc8a75-2");
    expect(output).toContain("Kein automatischer Neuversuch");
    expect(output).not.toContain("synthetic-private-detail");
    expect(output).not.toContain("AGY exited");
  });

  it.each([
    [{ error_code: 401 }, "denied access"],
    [{ status: "PERMISSION_DENIED" }, "denied access"],
    [{ status: "DEADLINE_EXCEEDED" }, "timed out"],
    [{ status: "UNAVAILABLE", error_code: 503 }, "temporarily unavailable"],
  ])("classifies structured provider errors without exposing free text", (details, expected) => {
    expect(formatAgyFailure(cliError(details), "Test model", 1)).toContain(expected);
  });

  it("classifies the local and durable timeout signatures", () => {
    for (const message of ["AGY timed out after 600000ms", "timeout waiting for response"]) {
      expect(formatAgyFailure(new Error(message), "Test model", 600)).toContain("timed out");
    }
  });

  it("does not expose malformed JSON, arbitrary errors, injected IDs or reset text", () => {
    const errors = [
      "AGY_ERROR: {bad synthetic-private-stderr}",
      "synthetic-private-stderr\nstack trace",
      cliError({
        status: "RESOURCE_EXHAUSTED",
        error_code: 429,
        error_id: "synthetic-private-stderr\nInjected",
        short_error: "Resets in synthetic-private-stderr.",
      }),
    ];
    for (const error of errors) {
      const output = formatAgyFailure(error, "Test model", NaN);
      expect(output).not.toContain("synthetic-private-stderr");
      expect(output).not.toContain("stack trace");
      expect(output).toContain("Duration: 0s");
    }
  });
});
