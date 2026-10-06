import type { ChildProcess } from "node:child_process";

export class AgentRunAbortedError extends Error {
  constructor() {
    super("Agent run aborted by user");
    this.name = "AgentRunAbortedError";
  }
}

let activeRun: AgentRun | null = null;

// A prompt owns its preparation and child/worker, never discovery or another job.
export class AgentRun {
  aborted = false;
  private child: ChildProcess | null = null;
  private childClosed = false;
  private signalSent = false;
  private workerAbort: (() => Promise<boolean>) | null = null;
  private workerStop: Promise<boolean> | null = null;
  private workerStopConfirmed = true;
  private operationFinished = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveFinished!: () => void;
  private readonly finished = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  throwIfAborted(): void {
    if (
      this.aborted &&
      !this.workerAbort &&
      (!this.child || (this.childClosed && this.signalSent))
    ) {
      throw new AgentRunAbortedError();
    }
  }

  registerChild(child: ChildProcess): void {
    this.child = child;
    child.once("close", () => {
      this.childClosed = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.releaseIfFinished();
    });
    child.once("error", () => {
      // A failed spawn has no process to wait for. Other errors need close evidence.
      if (child.pid === undefined) {
        this.childClosed = true;
        this.releaseIfFinished();
      }
    });
    if (this.aborted) this.terminate();
  }

  terminate(): void {
    if (!this.child || this.childClosed || this.killTimer) return;
    this.signalSent = this.child.kill("SIGTERM") || this.signalSent;
    if (this.childClosed) return;
    this.killTimer = setTimeout(() => {
      if (!this.childClosed && this.child) {
        this.signalSent = this.child.kill("SIGKILL") || this.signalSent;
      }
    }, 1_000);
    this.killTimer.unref();
  }

  registerWorkerAbort(abort: () => Promise<boolean>): void {
    this.workerAbort = abort;
    if (this.aborted) this.stopWorker();
  }

  private stopWorker(): void {
    if (this.workerAbort && !this.workerStop) {
      this.workerStop = this.workerAbort().catch(() => false);
    }
  }

  holdForWorkerStop(stop: Promise<boolean>): void {
    this.workerStopConfirmed = false;
    void stop
      .then((stopped) => {
        if (stopped) {
          this.workerStopConfirmed = true;
          this.releaseIfFinished();
        }
      })
      .catch(() => {});
  }

  finish(): void {
    this.operationFinished = true;
    this.releaseIfFinished();
  }

  private releaseIfFinished(): void {
    if (!this.operationFinished || !this.workerStopConfirmed || (this.child && !this.childClosed))
      return;
    if (activeRun === this) activeRun = null;
    this.resolveFinished();
  }

  async abort(): Promise<boolean> {
    // A naturally completed child cannot be retroactively reported as aborted.
    if (this.childClosed && !this.aborted) return false;
    this.aborted = true;
    this.terminate();
    this.stopWorker();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.finished.then(async () =>
          this.workerStop ? await this.workerStop : !this.child || this.signalSent,
        ),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function beginAgentRun(): AgentRun {
  if (activeRun) throw new Error("Agent run already active");
  activeRun = new AgentRun();
  return activeRun;
}

export function isAgentRunActive(): boolean {
  return activeRun !== null;
}

export function abortActiveAgentRun(): Promise<boolean> | null {
  return activeRun ? activeRun.abort() : null;
}
