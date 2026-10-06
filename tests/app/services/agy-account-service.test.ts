import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

  it("loads private account labels but requires an independent AGY sign-in", async () => {
    const directory = path.join(accountsDirectory, "google-abc");
    await mkdir(path.join(directory, "home"), { recursive: true });
    await writeFile(
      path.join(directory, "account.json"),
      JSON.stringify({ email: "alex@example.com", displayName: "Alex" }),
    );
    mocked.selectedAccount = "google-abc";

    expect(await listAgyAccounts()).toContainEqual(
      expect.objectContaining({
        alias: "google-abc",
        displayName: "alex@example.com",
        requiresLogin: true,
      }),
    );
    await expect(resolveSelectedAgyAccount()).rejects.toThrow("requires AGY sign-in");

    const dataDirectory = path.join(directory, "home", ".gemini", "antigravity-cli");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(dataDirectory, "antigravity-oauth-token"), "private-fixture");
    await expect(resolveSelectedAgyAccount()).rejects.toThrow("requires AGY sign-in");
    const credential = await lstat(path.join(dataDirectory, "antigravity-oauth-token"));
    await writeFile(
      path.join(directory, "identity.json"),
      JSON.stringify({ email: "wrong@example.com", credential }),
    );
    await expect(resolveSelectedAgyAccount()).rejects.toThrow("requires AGY sign-in");
    await writeFile(
      path.join(directory, "identity.json"),
      JSON.stringify({ email: "alex@example.com", credential }),
    );
    expect(await resolveSelectedAgyAccount()).toMatchObject({ requiresLogin: false });
    await writeFile(path.join(dataDirectory, "antigravity-oauth-token"), "changed-session-fixture");
    await expect(resolveSelectedAgyAccount()).rejects.toThrow("requires AGY sign-in");
  });

  it("does not treat an imported account with missing metadata as a legacy profile", async () => {
    const alias = "google-0123456789abcdef";
    await mkdir(path.join(accountsDirectory, alias, "home"), { recursive: true });
    mocked.selectedAccount = alias;
    expect((await listAgyAccounts()).map((account) => account.alias)).toEqual(["default"]);
    await expect(resolveSelectedAgyAccount()).rejects.toThrow("profile is unavailable");
  });

  it("keeps the default available when one imported metadata file is damaged", async () => {
    const directory = path.join(accountsDirectory, "google-broken");
    await mkdir(path.join(directory, "home"), { recursive: true });
    await writeFile(path.join(directory, "account.json"), "{broken");
    expect((await listAgyAccounts()).map((account) => account.alias)).toEqual(["default"]);
    expect(await resolveSelectedAgyAccount()).toMatchObject({ isDefault: true });
  });

  it("rejects another profile's home instead of following a symlink", async () => {
    const directory = path.join(accountsDirectory, "google-linked");
    await mkdir(directory);
    await symlink(os.homedir(), path.join(directory, "home"));
    expect((await listAgyAccounts()).map((account) => account.alias)).toEqual(["default"]);
  });
});
