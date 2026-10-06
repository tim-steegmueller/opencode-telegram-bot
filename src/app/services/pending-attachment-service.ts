import type { FilePartInput } from "@opencode-ai/sdk/v2";

export const PENDING_ATTACHMENT_TTL_MINUTES = 3;
const PENDING_ATTACHMENT_TTL_MS = PENDING_ATTACHMENT_TTL_MINUTES * 60 * 1000;

interface PendingAttachmentEntry {
  expiresAt: number;
  fileParts: FilePartInput[];
}

const pendingAttachments = new Map<number, PendingAttachmentEntry>();

export function storePendingAttachments(chatId: number, fileParts: FilePartInput[]): void {
  const existing = getPendingAttachments(chatId);
  pendingAttachments.set(chatId, {
    expiresAt: Date.now() + PENDING_ATTACHMENT_TTL_MS,
    fileParts: [...existing, ...fileParts],
  });
}

export function getPendingAttachments(chatId: number): FilePartInput[] {
  const entry = pendingAttachments.get(chatId);
  if (!entry) {
    return [];
  }

  if (entry.expiresAt <= Date.now()) {
    pendingAttachments.delete(chatId);
    return [];
  }

  return [...entry.fileParts];
}

export function clearPendingAttachments(chatId: number): void {
  pendingAttachments.delete(chatId);
}

export function __resetPendingAttachmentsForTests(): void {
  pendingAttachments.clear();
}
