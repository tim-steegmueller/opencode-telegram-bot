import { lstat, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgyAccount } from "../stores/settings-store.js";
import { logger } from "../../utils/logger.js";

export const DEFAULT_AGY_ACCOUNT = "default";
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9._@-]{1,40}$/;

export interface AgyAccountProfile {
  alias: string;
  homeDirectory: string;
  isDefault: boolean;
  displayName?: string;
  requiresLogin?: boolean;
}

export function getAgyAccountsDirectory(): string {
  return (
    process.env.AGY_ACCOUNTS_DIR?.trim() ||
    path.join(os.homedir(), ".local", "share", "telegram-agent", "accounts")
  );
}

export async function listAgyAccounts(): Promise<AgyAccountProfile[]> {
  const accounts: AgyAccountProfile[] = [
    {
      alias: DEFAULT_AGY_ACCOUNT,
      homeDirectory: os.homedir(),
      isDefault: true,
    },
  ];

  try {
    if (!(await lstat(getAgyAccountsDirectory())).isDirectory()) return accounts;
    const entries = await readdir(getAgyAccountsDirectory(), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !ACCOUNT_NAME_PATTERN.test(entry.name)) {
        continue;
      }

      const homeDirectory = path.join(getAgyAccountsDirectory(), entry.name, "home");
      if ((await lstat(homeDirectory).catch(() => null))?.isDirectory()) {
        const profile: AgyAccountProfile = { alias: entry.name, homeDirectory, isDefault: false };
        const metadataPath = path.join(getAgyAccountsDirectory(), entry.name, "account.json");
        try {
          const metadataInfo = await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (metadataInfo && !metadataInfo.isFile()) continue;
          const metadata = await readFile(metadataPath, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (metadata === undefined && /^google-[a-f0-9]{16}$/.test(entry.name)) continue;
          if (metadata !== undefined) {
            const data = JSON.parse(metadata) as { email?: unknown };
            if (
              typeof data.email !== "string" ||
              !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(data.email)
            ) {
              throw new Error(`Invalid AGY account metadata: ${entry.name}`);
            }
            profile.displayName = data.email;
            // Only a matching identity emitted by the official CLI enables an imported profile.
            const credentialFile = path.join(
              homeDirectory,
              ".gemini",
              "antigravity-cli",
              "antigravity-oauth-token",
            );
            const gemini = await lstat(path.dirname(path.dirname(credentialFile))).catch(
              () => null,
            );
            const cliDirectory = await lstat(path.dirname(credentialFile)).catch(() => null);
            const credential = await lstat(credentialFile).catch(() => null);
            const identityPath = path.join(getAgyAccountsDirectory(), entry.name, "identity.json");
            const identityInfo = await lstat(identityPath).catch(() => null);
            const identity = identityInfo?.isFile()
              ? (JSON.parse(await readFile(identityPath, "utf8")) as {
                  email?: string;
                  credential?: { ino?: number; size?: number; mtimeMs?: number };
                })
              : undefined;
            profile.requiresLogin = !(
              gemini?.isDirectory() &&
              cliDirectory?.isDirectory() &&
              credential?.isFile() &&
              credential.size > 0 &&
              identity?.email === data.email &&
              identity.credential?.ino === credential.ino &&
              identity.credential?.size === credential.size &&
              identity.credential?.mtimeMs === credential.mtimeMs
            );
          }
          accounts.push(profile);
        } catch {
          logger.warn(`[Account] Ignoring damaged account metadata: ${entry.name}`);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return accounts;
}

export async function resolveSelectedAgyAccount(): Promise<AgyAccountProfile> {
  const selectedAlias = getAgyAccount();
  const account = (await listAgyAccounts()).find((profile) => profile.alias === selectedAlias);
  if (!account) {
    throw new Error(`AGY account profile is unavailable: ${selectedAlias}`);
  }
  if (account.requiresLogin) {
    throw new Error(`AGY account requires AGY sign-in: ${selectedAlias}`);
  }

  return account;
}
