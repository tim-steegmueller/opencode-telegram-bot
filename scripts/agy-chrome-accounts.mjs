import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "chrome-state": { type: "string" },
    inventory: { type: "string" },
    "accounts-dir": { type: "string" },
    agy: { type: "string" },
  },
});
const directory = path.resolve(
  values["accounts-dir"] ??
    process.env.AGY_ACCOUNTS_DIR ??
    path.join(os.homedir(), ".local/share/telegram-agent/accounts"),
);

async function privateDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Account directories must not be symbolic links");
  await chmod(target, 0o700);
}

async function writePrivateJson(target, data) {
  const temporaryPath = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, target);
}

async function importAccounts() {
  const accounts = new Map();
  function add(email) {
    if (typeof email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email))
      throw new Error("Invalid account email in identity inventory");
    const normalized = email.toLowerCase();
    accounts.set(normalized, normalized);
  }
  const chromeState =
    values["chrome-state"] ??
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/Google/Chrome/Local State")
      : undefined);
  if (chromeState) {
    const state = JSON.parse(await readFile(chromeState, "utf8"));
    for (const profile of Object.values(state.profile?.info_cache ?? {})) {
      if (profile.user_name) add(profile.user_name);
    }
  }
  if (values.inventory) {
    const inventory = JSON.parse(await readFile(values.inventory, "utf8"));
    if (!Array.isArray(inventory))
      throw new Error("Account inventory must be an array of email records");
    for (const account of inventory) add(account?.email);
  }
  if (!accounts.size)
    throw new Error("No Chrome account identities found; no profiles were created");
  await privateDirectory(directory);
  for (const email of [...accounts.values()].sort()) {
    const alias = `google-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
    const profile = path.join(directory, alias);
    await privateDirectory(profile);
    await privateDirectory(path.join(profile, "home"));
    const metadataPath = path.join(profile, "account.json");
    const metadata = `${JSON.stringify({ email })}\n`;
    try {
      await writeFile(metadataPath, metadata, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await lstat(metadataPath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        JSON.parse(await readFile(metadataPath, "utf8")).email !== email
      )
        throw new Error("Existing account metadata does not match; nothing was overwritten");
      await chmod(metadataPath, 0o600);
    }
  }
  process.stdout.write(
    `Imported ${accounts.size} account identities. No cookies, tokens or AGY sessions were copied. Sign in to each isolated profile before selection.\n`,
  );
}

async function login(alias) {
  if (!/^google-[a-f0-9]{16}$/.test(alias ?? ""))
    throw new Error("Choose an imported account alias from /account");
  const profile = path.join(directory, alias);
  for (const target of [directory, profile, path.join(profile, "home")]) {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid isolated account directory");
  }
  const metadataPath = path.join(profile, "account.json");
  if (!(await lstat(metadataPath)).isFile()) throw new Error("Invalid isolated account metadata");
  const { email } = JSON.parse(await readFile(metadataPath, "utf8"));
  if (typeof email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email))
    throw new Error("Invalid account identity");
  const env = { ...process.env, HOME: path.join(profile, "home") };
  // A selected Google session must never turn into a paid API-key request.
  delete env.GEMINI_API_KEY;
  delete env.AGY_DATA_DIR;
  const executable =
    values.agy ?? process.env.AGY_CLI_PATH ?? path.join(os.homedir(), ".local/bin/agy");
  const dataDirectory = path.join(env.HOME, ".gemini", "antigravity-cli");
  await privateDirectory(path.dirname(dataDirectory));
  await privateDirectory(dataDirectory);
  const settingsPath = path.join(dataDirectory, "settings.json");
  const settingsInfo = await lstat(settingsPath).catch(() => null);
  if (settingsInfo && !settingsInfo.isFile()) throw new Error("Invalid isolated AGY settings file");
  const settings = settingsInfo ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
  const previousStatusLine = settings.statusLine;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [
    process.execPath,
    fileURLToPath(import.meta.url),
    "record-identity",
    alias,
    "--accounts-dir",
    directory,
  ]
    .map(quote)
    .join(" ");
  settings.statusLine = { type: "command", command, enabled: true };
  await writePrivateJson(settingsPath, settings);
  process.stdout.write(
    `Sign in as ${email} in the official AGY browser flow. Do not use /logout in the default profile.\n`,
  );
  const child = spawn(executable, [], { cwd: env.HOME, env, stdio: "inherit" });
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("Could not start the configured AGY CLI")));
      child.once("exit", (code) => resolve(interrupted ? 130 : (code ?? 1)));
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    const current = JSON.parse(await readFile(settingsPath, "utf8"));
    if (current.statusLine?.command === command) {
      if (previousStatusLine === undefined) delete current.statusLine;
      else current.statusLine = previousStatusLine;
      await writePrivateJson(settingsPath, current);
    }
  }
}

async function recordIdentity(alias) {
  if (!/^google-[a-f0-9]{16}$/.test(alias ?? "")) throw new Error("Invalid imported account alias");
  const profile = path.join(directory, alias);
  const identityPath = path.join(profile, "identity.json");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 65536) throw new Error("CLI identity payload is too large");
  }
  const payload = JSON.parse(raw);
  const metadataPath = path.join(profile, "account.json");
  if (!(await lstat(metadataPath)).isFile()) throw new Error("Invalid isolated account metadata");
  const { email } = JSON.parse(await readFile(metadataPath, "utf8"));
  const credentialPath = path.join(
    profile,
    "home",
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token",
  );
  const safeDirectories = [
    directory,
    profile,
    path.join(profile, "home"),
    path.dirname(path.dirname(credentialPath)),
    path.dirname(credentialPath),
  ];
  for (const target of safeDirectories) {
    if (!(await lstat(target)).isDirectory()) throw new Error("Invalid isolated account directory");
  }
  const credential = await lstat(credentialPath);
  if (
    typeof payload.email !== "string" ||
    payload.email.toLowerCase() !== email ||
    !credential.isFile() ||
    credential.size === 0
  ) {
    await rm(identityPath, { force: true });
    throw new Error(
      "AGY identity does not match the requested Chrome account; profile remains unavailable",
    );
  }
  await writePrivateJson(identityPath, {
    email,
    verifiedAt: new Date().toISOString(),
    source: "agy-statusline",
    credential: { ino: credential.ino, size: credential.size, mtimeMs: credential.mtimeMs },
  });
  process.stdout.write("AGY account identity verified");
}

try {
  if (positionals[0] === "import" && positionals.length === 1) await importAccounts();
  else if (positionals[0] === "login" && positionals.length === 2) await login(positionals[1]);
  else if (positionals[0] === "record-identity" && positionals.length === 2)
    await recordIdentity(positionals[1]);
  else
    throw new Error(
      "Usage: node scripts/agy-chrome-accounts.mjs import [--chrome-state FILE] [--inventory FILE] | login ALIAS [--agy PATH]",
    );
} catch (error) {
  // Do not echo raw JSON or credential-bearing provider errors.
  process.stderr.write(
    `${error instanceof SyntaxError ? "Invalid account metadata JSON" : error.message}\n`,
  );
  process.exitCode = 1;
}
