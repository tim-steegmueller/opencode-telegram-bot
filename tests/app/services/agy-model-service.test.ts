import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), account: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.runFile }),
}));
vi.mock("../../../src/app/services/agy-account-service.js", () => ({
  resolveSelectedAgyAccount: mocks.account,
}));

describe("live AGY model catalog", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.runFile.mockReset();
    mocks.account.mockResolvedValue({ homeDirectory: "/tmp/agy-account" });
  });

  it("parses current CLI IDs, display names and unknown future model families", async () => {
    const { parseAgyModels } = await import("../../../src/app/services/agy-model-service.js");
    expect(
      parseAgyModels(
        "Fetching available models...\n" +
          "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
          "new-model-9\tA future model\n",
      ).map((model) => model.modelID),
    ).toEqual(["gemini-3.8-flash-high", "new-model-9"]);
  });

  it("rejects an empty or unreadable catalog instead of inventing old choices", async () => {
    const { parseAgyModels } = await import("../../../src/app/services/agy-model-service.js");
    expect(() => parseAgyModels("network failure")).toThrow("no readable model catalog");
  });

  it("uses the selected account for discovery and caches only within that account", async () => {
    const { listAgyModels } = await import("../../../src/app/services/agy-model-service.js");
    mocks.runFile.mockResolvedValue({ stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)" });
    vi.stubEnv("GEMINI_API_KEY", "fixture-key");
    vi.stubEnv("AGY_DATA_DIR", "/fixture/another-account");
    try {
      await listAgyModels();
      await listAgyModels();
      await listAgyModels("/tmp/another-account");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
    expect(mocks.runFile.mock.calls[0][1]).toEqual(["models"]);
    expect(mocks.runFile.mock.calls[0][2].env.HOME).toBe("/tmp/agy-account");
    expect(mocks.runFile.mock.calls[0][2].env.GEMINI_API_KEY).toBeUndefined();
    expect(mocks.runFile.mock.calls[0][2].env.AGY_DATA_DIR).toBeUndefined();
    expect(mocks.runFile.mock.calls[1][2].env.HOME).toBe("/tmp/another-account");
  });

  it("passes through the exact advertised name and rejects a retired ID without fallback", async () => {
    const { resolveAgyModel } = await import("../../../src/app/services/agy-model-service.js");
    mocks.runFile.mockResolvedValue({ stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)" });
    expect(
      (await resolveAgyModel({ providerID: "antigravity", modelID: "gemini-3.8-flash-high" }))
        .displayName,
    ).toBe("Gemini 3.8 Flash (High)");
    await expect(
      resolveAgyModel({ providerID: "antigravity", modelID: "retired-model" }),
    ).rejects.toThrow("no fallback was used");
  });

  it("rejects an explicit incompatible provider without discovering or substituting a model", async () => {
    const { resolveAgyModel } = await import("../../../src/app/services/agy-model-service.js");
    await expect(resolveAgyModel({ providerID: "openai", modelID: "gpt-5" })).rejects.toThrow(
      "choose an AGY model explicitly",
    );
    expect(mocks.runFile).not.toHaveBeenCalled();
    mocks.runFile.mockResolvedValue({ stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)" });
    expect((await resolveAgyModel()).modelID).toBe("gemini-3.8-flash-high");
  });

  it("does not keep serving an expired catalog after discovery fails", async () => {
    const { listAgyModels } = await import("../../../src/app/services/agy-model-service.js");
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      mocks.runFile.mockResolvedValueOnce({
        stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      });
      await listAgyModels();
      now.mockReturnValue(62000);
      mocks.runFile.mockRejectedValueOnce(new Error("catalog unavailable"));
      await expect(listAgyModels()).rejects.toThrow("catalog unavailable");
    } finally {
      now.mockRestore();
    }
  });
});
