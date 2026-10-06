import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Chrome AGY account import CLI", () => {
  let directory: string;
  let accountsDirectory: string;
  let chromeState: string;
  let inventory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "chrome-account-import-"));
    accountsDirectory = path.join(directory, "accounts");
    chromeState = path.join(directory, "Local State");
    inventory = path.join(directory, "inventory.json");
    await writeFile(
      chromeState,
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { user_name: "alex@example.com" },
            "Profile 2": { user_name: "" },
            "Profile 3": { user_name: "ALEX@example.com" },
          },
        },
      }),
    );
    await writeFile(
      inventory,
      JSON.stringify([{ email: "other@example.com" }, { email: "alex@example.com" }]),
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function run() {
    return spawnSync(
      process.execPath,
      [
        "scripts/agy-chrome-accounts.mjs",
        "import",
        "--chrome-state",
        chromeState,
        "--inventory",
        inventory,
        "--accounts-dir",
        accountsDirectory,
      ],
      { encoding: "utf8" },
    );
  }

  it("deduplicates profile and live chooser identities and creates private metadata only", async () => {
    expect(run().status).toBe(0);
    const aliases = await readdir(accountsDirectory);
    expect(aliases).toHaveLength(2);
    for (const alias of aliases) {
      expect(alias).toMatch(/^google-[a-f0-9]{16}$/);
      const profile = path.join(accountsDirectory, alias);
      expect((await stat(profile)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(profile, "account.json"))).mode & 0o777).toBe(0o600);
      expect(await readdir(path.join(profile, "home"))).toEqual([]);
    }
    const before = await Promise.all(
      aliases.map((alias) => readFile(path.join(accountsDirectory, alias, "account.json"), "utf8")),
    );
    expect(run().status).toBe(0);
    expect(
      await Promise.all(
        aliases.map((alias) =>
          readFile(path.join(accountsDirectory, alias, "account.json"), "utf8"),
        ),
      ),
    ).toEqual(before);
  });

  it("rejects invalid identities before creating any profiles", async () => {
    await writeFile(inventory, JSON.stringify([{ email: "../outside" }]));
    expect(run().status).toBe(1);
    await expect(stat(accountsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function fakeLogin(email: string) {
    expect(run().status).toBe(0);
    const aliases = await readdir(accountsDirectory);
    const alias = (
      await Promise.all(
        aliases.map(async (alias) => ({
          alias,
          data: JSON.parse(
            await readFile(path.join(accountsDirectory, alias, "account.json"), "utf8"),
          ),
        })),
      )
    ).find((entry) => entry.data.email === "alex@example.com")!.alias;
    const cliDirectory = path.join(accountsDirectory, alias, "home", ".gemini", "antigravity-cli");
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(
      path.join(cliDirectory, "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "original-status" },
        theme: "original",
      }),
    );
    const executable = path.join(directory, "fake-agy.mjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nconst root=process.env.HOME+'/.gemini/antigravity-cli';\nif(process.env.GEMINI_API_KEY || process.env.AGY_DATA_DIR) process.exit(9);\nwriteFileSync(root+'/antigravity-oauth-token','fixture-auth');\nconst settings=JSON.parse(readFileSync(root+'/settings.json','utf8'));\nconst result=spawnSync(settings.statusLine.command,{shell:true,input:JSON.stringify({email:${JSON.stringify(email)},private_fixture:'must-not-be-persisted'}),encoding:'utf8'});\nsettings.theme='changed-by-cli';writeFileSync(root+'/settings.json',JSON.stringify(settings));\nprocess.exit(result.status);\n`,
    );
    await chmod(executable, 0o700);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/agy-chrome-accounts.mjs",
        "login",
        alias,
        "--accounts-dir",
        accountsDirectory,
        "--agy",
        executable,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GEMINI_API_KEY: "fixture-key", AGY_DATA_DIR: "/fixture/other" },
      },
    );
    expect(JSON.parse(await readFile(path.join(cliDirectory, "settings.json"), "utf8"))).toEqual({
      statusLine: { type: "command", command: "original-status" },
      theme: "changed-by-cli",
    });
    return { result, identityPath: path.join(accountsDirectory, alias, "identity.json") };
  }

  it("records only a matching official CLI identity and restores status-line settings", async () => {
    const { result, identityPath } = await fakeLogin("alex@example.com");
    expect(result.status).toBe(0);
    const identity = JSON.parse(await readFile(identityPath, "utf8"));
    expect(identity).toMatchObject({ email: "alex@example.com", source: "agy-statusline" });
    expect(identity).not.toHaveProperty("private_fixture");
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "restores settings when login is cancelled with %s",
    async (signal) => {
      expect(run().status).toBe(0);
      const alias = (await readdir(accountsDirectory))[0];
      const cliDirectory = path.join(
        accountsDirectory,
        alias,
        "home",
        ".gemini",
        "antigravity-cli",
      );
      await mkdir(cliDirectory, { recursive: true });
      const settingsPath = path.join(cliDirectory, "settings.json");
      const original = {
        statusLine: { type: "command", command: "original-status" },
        theme: "original",
      };
      await writeFile(settingsPath, JSON.stringify(original));
      const executable = path.join(directory, "waiting-agy.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node\nprocess.stdout.write('fixture-ready\\n');setInterval(()=>{},1000);\n`,
      );
      await chmod(executable, 0o700);
      const helper = spawn(
        process.execPath,
        [
          "scripts/agy-chrome-accounts.mjs",
          "login",
          alias,
          "--accounts-dir",
          accountsDirectory,
          "--agy",
          executable,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = new Promise((resolve, reject) => {
        helper.once("error", reject);
        helper.once("exit", resolve);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          helper.stdout.on("data", (data: Buffer) => {
            if (data.toString().includes("fixture-ready")) resolve();
          });
          helper.once("error", reject);
          helper.once("exit", () => reject(new Error("Helper exited before cancellation test")));
        });
        helper.kill(signal);
        expect(await exited).toBe(130);
        expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(original);
      } finally {
        if (helper.exitCode === null) helper.kill("SIGTERM");
      }
    },
  );

  it("keeps a wrong-account sign-in unavailable", async () => {
    const { result, identityPath } = await fakeLogin("wrong@example.com");
    expect(result.status).toBe(1);
    await expect(stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
