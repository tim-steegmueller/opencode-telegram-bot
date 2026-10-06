import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  projectRoot: "",
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: () => ({ id: "test", name: "test", worktree: mocked.projectRoot }),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getFileDetails,
  isWithinProjectRootSafe,
} from "../../../src/app/services/file-browser-service.js";

describe("file browser realpath boundary", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "file-browser-security-"));
    mocked.projectRoot = path.join(root, "project");
    await mkdir(mocked.projectRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts regular project files but rejects symlinks escaping the project", async () => {
    const regularFile = path.join(mocked.projectRoot, "README.md");
    const secretFile = path.join(root, "secret.txt");
    const symlinkPath = path.join(mocked.projectRoot, "secret-link.txt");
    await writeFile(regularFile, "safe");
    await writeFile(secretFile, "secret");
    await symlink(secretFile, symlinkPath);

    await expect(isWithinProjectRootSafe(regularFile)).resolves.toBe(true);
    await expect(isWithinProjectRootSafe(symlinkPath)).resolves.toBe(false);
    await expect(getFileDetails(symlinkPath)).resolves.toEqual({
      error: "⛔ Access denied: path is outside the current project",
    });
  });
});
