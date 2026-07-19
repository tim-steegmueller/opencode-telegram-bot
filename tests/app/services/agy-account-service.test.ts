import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ selectedAccount: "default" }));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getAgyAccount: () => mocked.selectedAccount,
}));

import {
  listAgyAccounts,
  resolveSelectedAgyAccount,
} from "../../../src/app/services/agy-account-service.js";

describe("app/services/agy-account-service", () => {
  let accountsDirectory = "";

  beforeEach(async () => {
    accountsDirectory = await mkdtemp(path.join(os.tmpdir(), "agy-accounts-test-"));
    process.env.AGY_ACCOUNTS_DIR = accountsDirectory;
    mocked.selectedAccount = "default";
  });

  afterEach(async () => {
    delete process.env.AGY_ACCOUNTS_DIR;
    await rm(accountsDirectory, { recursive: true, force: true });
  });

  it("lists only account aliases that contain an isolated home directory", async () => {
    await mkdir(path.join(accountsDirectory, "google-2", "home"), { recursive: true });
    await mkdir(path.join(accountsDirectory, "incomplete"), { recursive: true });

    const accounts = await listAgyAccounts();

    expect(accounts.map((account) => account.alias)).toEqual(["default", "google-2"]);
  });

  it("fails instead of silently falling back when the selected profile disappeared", async () => {
    mocked.selectedAccount = "missing";

    await expect(resolveSelectedAgyAccount()).rejects.toThrow(
      "AGY account profile is unavailable: missing",
    );
  });
});
