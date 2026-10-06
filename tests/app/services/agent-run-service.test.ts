import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortActiveAgentRun,
  beginAgentRun,
  AgentRunAbortedError,
  isAgentRunActive,
} from "../../../src/app/services/agent-run-service.js";

function createChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => vi.useRealTimers());

describe("direct agent run ownership", () => {
  it("blocks a second engine and aborts preparation before any child exists", async () => {
    const run = beginAgentRun();
    expect(() => beginAgentRun()).toThrow("already active");
    const stopped = abortActiveAgentRun();
    expect(() => run.throwIfAborted()).toThrow(AgentRunAbortedError);
    run.finish();
    await expect(stopped).resolves.toBe(true);
    expect(isAgentRunActive()).toBe(false);
    expect(abortActiveAgentRun()).toBeNull();
  });

  it("waits for close and cleanup rather than treating kill acceptance as success", async () => {
    const run = beginAgentRun();
    const child = createChild();
    run.registerChild(child as unknown as ChildProcess);
    const stopped = abortActiveAgentRun();
    run.finish();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(isAgentRunActive()).toBe(true);
    child.emit("close", null, "SIGTERM");
    await expect(stopped).resolves.toBe(true);
    expect(isAgentRunActive()).toBe(false);
  });

  it("escalates only its child and retains the lease if closure is unconfirmed", async () => {
    vi.useFakeTimers();
    const run = beginAgentRun();
    const child = createChild();
    run.registerChild(child as unknown as ChildProcess);
    const stopped = abortActiveAgentRun();
    run.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(stopped).resolves.toBe(false);
    expect(isAgentRunActive()).toBe(true);
    expect(() => beginAgentRun()).toThrow("already active");
    child.emit("close", null, "SIGKILL");
    expect(isAgentRunActive()).toBe(false);
  });

  it("does not turn a naturally finished result into an aborted job during cleanup", async () => {
    const run = beginAgentRun();
    const child = createChild();
    run.registerChild(child as unknown as ChildProcess);
    child.emit("close", 0, null);
    await expect(abortActiveAgentRun()).resolves.toBe(false);
    expect(run.aborted).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(isAgentRunActive()).toBe(true);
    run.finish();
    expect(isAgentRunActive()).toBe(false);
  });

  it("does not report an aborted outcome before an errored spawned child closes", async () => {
    vi.useFakeTimers();
    const run = beginAgentRun();
    const child = createChild();
    Object.assign(child, { pid: 12345 });
    run.registerChild(child as unknown as ChildProcess);
    const stopped = abortActiveAgentRun();
    child.emit("error", new Error("stream failure"));
    expect(() => run.throwIfAborted()).not.toThrow();
    run.finish();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopped).resolves.toBe(false);
    expect(isAgentRunActive()).toBe(true);
    child.emit("close", null, "SIGKILL");
    expect(() => run.throwIfAborted()).toThrow(AgentRunAbortedError);
    expect(isAgentRunActive()).toBe(false);
  });

  it("does not confirm a stop when signal delivery failed and the child completed normally", async () => {
    const run = beginAgentRun();
    const child = createChild();
    child.kill.mockReturnValue(false);
    run.registerChild(child as unknown as ChildProcess);
    const stopped = abortActiveAgentRun();
    child.emit("close", 0, null);
    expect(() => run.throwIfAborted()).not.toThrow();
    run.finish();
    await expect(stopped).resolves.toBe(false);
    expect(isAgentRunActive()).toBe(false);
  });

  it("binds a pending worker stop to the captured job and waits for its outcome", async () => {
    const run = beginAgentRun();
    const stopped = abortActiveAgentRun();
    const stopWorker = vi.fn().mockResolvedValue(false);
    run.registerWorkerAbort(stopWorker);
    run.finish();
    await expect(stopped).resolves.toBe(false);
    expect(stopWorker).toHaveBeenCalledTimes(1);
    expect(isAgentRunActive()).toBe(false);
  });

  it("retains ownership when a dispatch cleanup cannot confirm worker stop", async () => {
    vi.useFakeTimers();
    const run = beginAgentRun();
    const stop = Promise.resolve(false);
    run.registerWorkerAbort(() => stop);
    run.holdForWorkerStop(stop);
    const stopped = abortActiveAgentRun();
    run.finish();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopped).resolves.toBe(false);
    expect(isAgentRunActive()).toBe(true);
    expect(() => beginAgentRun()).toThrow("already active");
    // Fixture cleanup represents new positive stop evidence, not a repeated stop request.
    run.holdForWorkerStop(Promise.resolve(true));
    await Promise.resolve();
    expect(isAgentRunActive()).toBe(false);
  });

  it("releases a failed spawn without inventing a successful job", () => {
    const run = beginAgentRun();
    const child = createChild();
    run.registerChild(child as unknown as ChildProcess);
    child.emit("error", new Error("ENOENT"));
    run.finish();
    expect(isAgentRunActive()).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "terminates a real owned child that ignores SIGTERM",
    async () => {
      const run = beginAgentRun();
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      run.registerChild(child);
      try {
        await once(child.stdout!, "data");
        const closed = once(child, "close");
        const stopped = abortActiveAgentRun();
        const [code, signal] = await closed;
        expect(code).toBeNull();
        expect(signal).toBe("SIGKILL");
        run.finish();
        await expect(stopped).resolves.toBe(true);
        expect(isAgentRunActive()).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        run.finish();
      }
    },
  );
});
