import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const STT_REQUEST_TIMEOUT_MS = 60_000;

export interface SttResult {
  text: string;
}

/**
 * Returns true if a local command or a remote API is configured.
 */
export function isSttConfigured(): boolean {
  return Boolean(config.stt.command || (config.stt.apiUrl && config.stt.apiKey));
}

async function transcribeWithCommand(
  command: string,
  audioBuffer: Buffer,
  filename: string,
): Promise<SttResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-stt-"));
  const audioPath = path.join(directory, path.basename(filename) || "audio.ogg");

  try {
    await writeFile(audioPath, audioBuffer, { mode: 0o600 });
    const text = await new Promise<string>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const child = spawn(command, [audioPath], { stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`STT command timed out after ${STT_REQUEST_TIMEOUT_MS}ms`));
      }, STT_REQUEST_TIMEOUT_MS);
      timeout.unref();

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const stderrText = Buffer.concat(stderr).toString().trim();
        if (code !== 0) {
          reject(
            new Error(
              `STT command exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderrText}`,
            ),
          );
          return;
        }

        const stdoutText = Buffer.concat(stdout).toString().trim();
        if (!stdoutText) {
          reject(new Error("STT command returned an empty transcription"));
          return;
        }
        resolve(stdoutText);
      });
    });

    logger.debug(`[STT] Command transcription result: ${text.length} chars`);
    return { text };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Transcribes an audio buffer using a Whisper-compatible API (OpenAI / Groq / etc.).
 *
 * Sends a multipart/form-data POST to `{STT_API_URL}/audio/transcriptions`.
 *
 * @param audioBuffer - Raw audio file bytes (ogg, mp3, wav, m4a, webm, etc.)
 * @param filename    - Original filename with extension (used by the API to detect format)
 * @returns Transcribed text
 * @throws Error if STT is not configured, the request fails, or the response is invalid
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<SttResult> {
  if (!isSttConfigured()) {
    throw new Error(
      "STT is not configured: set STT_COMMAND or both STT_API_URL and STT_API_KEY",
    );
  }

  if (config.stt.command) {
    return transcribeWithCommand(config.stt.command, audioBuffer, filename);
  }

  const url = `${config.stt.apiUrl}/audio/transcriptions`;

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
  formData.append("model", config.stt.model);
  formData.append("response_format", "json");

  if (config.stt.language) {
    formData.append("language", config.stt.language);
  }

  logger.debug(
    `[STT] Sending transcription request: url=${url}, model=${config.stt.model}, filename=${filename}, size=${audioBuffer.length} bytes`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.stt.apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `STT API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const data = (await response.json()) as { text?: string };

    if (typeof data.text !== "string") {
      throw new Error("STT API response does not contain a text field");
    }

    logger.debug(`[STT] Transcription result: ${data.text.length} chars`);

    return { text: data.text };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`STT request timed out after ${STT_REQUEST_TIMEOUT_MS}ms`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
