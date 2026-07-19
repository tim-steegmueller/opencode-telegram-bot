import os from "node:os";
import path from "node:path";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import {
  __flushSettingsWritesForTests,
  __resetSettingsForTests,
  getAssistantMode,
  getTtsMode,
  loadSettings,
  setAssistantMode,
} from "../../../src/app/stores/settings-store.js";

describe("app/stores/settings-store", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-settings-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
  });

  afterEach(async () => {
    await __flushSettingsWritesForTests();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    __resetSettingsForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it.each([
    { oldValue: true, expectedMode: "all" },
    { oldValue: false, expectedMode: "off" },
  ] as const)(
    "migrates ttsEnabled=$oldValue to $expectedMode mode",
    async ({ oldValue, expectedMode }) => {
      await writeFile(
        path.join(tempHome, "settings.json"),
        JSON.stringify({ ttsEnabled: oldValue }, null, 2),
      );

      await loadSettings();

      expect(getTtsMode()).toBe(expectedMode);
    },
  );

  it("defaults assistant mode to opencode and stores explicit mode", () => {
    expect(getAssistantMode()).toBe("opencode");

    setAssistantMode("agy");

    expect(getAssistantMode()).toBe("agy");
  });

  it("keeps a queued write in the home selected when it was enqueued", async () => {
    const otherHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-other-home-"));

    setAssistantMode("agy");
    process.env.OPENCODE_TELEGRAM_HOME = otherHome;
    await __flushSettingsWritesForTests();

    const persisted = JSON.parse(
      await readFile(path.join(tempHome, "settings.json"), "utf-8"),
    ) as { assistantMode?: string };
    expect(persisted.assistantMode).toBe("agy");
    await expect(access(path.join(otherHome, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(otherHome, { recursive: true, force: true });
  });
});
