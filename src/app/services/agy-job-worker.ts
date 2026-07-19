import {
  readAgyJobRecord,
  readAndRemoveAgyJobRequest,
  writeAgyJobRecord,
} from "./agy-job-service.js";
import { executeAgyAgentPrompt } from "./agy-agent-service.js";
import { executeCursorAgentPrompt } from "./cursor-agent-service.js";
import path from "node:path";

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new Error("AGY job worker requires a request path");
  }

  process.env.AGY_JOBS_DIR = path.dirname(requestPath);

  const request = await readAndRemoveAgyJobRequest(requestPath);
  let record = await readAgyJobRecord(request.jobId);
  record = { ...record, status: "running" };
  await writeAgyJobRecord(record);

  let writeQueue = Promise.resolve();
  const queueProgressWrite = (line: string): void => {
    if (!record.activityLines.includes(line)) {
      record.activityLines = [...record.activityLines, line].slice(-8);
    }
    writeQueue = writeQueue.then(() => writeAgyJobRecord(record));
  };

  try {
    const result =
      request.backend === "cursor"
        ? await executeCursorAgentPrompt({
            prompt: request.prompt,
            projectDirectory: request.projectDirectory,
            model: request.model,
            attachments: request.attachments,
            timeoutMs: request.timeoutMs,
          })
        : await executeAgyAgentPrompt({
            prompt: request.prompt,
            projectDirectory: request.projectDirectory,
            model: request.model,
            attachments: request.attachments,
            accountHome: request.accountHome,
            timeoutMs: request.timeoutMs,
            onProgress: queueProgressWrite,
          });
    await writeQueue;
    record = {
      ...record,
      status: "completed",
      completedAt: new Date().toISOString(),
      modelName: result.modelName,
      output: result.output,
    };
    await writeAgyJobRecord(record);
  } catch (error) {
    await writeQueue;
    record = {
      ...record,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await writeAgyJobRecord(record);
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
