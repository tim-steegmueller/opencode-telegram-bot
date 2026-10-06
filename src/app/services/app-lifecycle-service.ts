let shuttingDown = false;

export function markAppRunning(): void {
  shuttingDown = false;
}

export function markAppShuttingDown(): void {
  shuttingDown = true;
}

export function isAppShuttingDown(): boolean {
  return shuttingDown;
}
