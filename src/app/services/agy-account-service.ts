import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgyAccount } from "../stores/settings-store.js";

export const DEFAULT_AGY_ACCOUNT = "default";
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9._@-]{1,40}$/;

export interface AgyAccountProfile {
  alias: string;
  homeDirectory: string;
  isDefault: boolean;
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
    const entries = await readdir(getAgyAccountsDirectory(), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !ACCOUNT_NAME_PATTERN.test(entry.name)) {
        continue;
      }

      const homeDirectory = path.join(getAgyAccountsDirectory(), entry.name, "home");
      if ((await stat(homeDirectory).catch(() => null))?.isDirectory()) {
        accounts.push({ alias: entry.name, homeDirectory, isDefault: false });
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

  return account;
}
