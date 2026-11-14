import type { Attachment } from '../types';

/**
 * Reading files the person attached to a prompt.
 *
 * Shared by the composer and Prompt Studio so one limit and one refusal apply wherever a file is
 * attached: an attachment becomes part of a message, and a message is text, so a binary file is
 * refused by name rather than pasted in as mojibake.
 */

export const MAX_ATTACHMENT_BYTES = 256 * 1024;

export interface ReadAttachmentsResult {
  added: Attachment[];
  /** What was left out, already worded for display, with the reason in each entry. */
  skipped: string[];
}

export async function readAttachmentFiles(files: readonly File[]): Promise<ReadAttachmentsResult> {
  const added: Attachment[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${file.name} (over ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB)`);
      continue;
    }
    const content = await file.text();
    // Text files never contain NUL characters; binary files almost always do.
    if (content.includes(String.fromCharCode(0))) {
      skipped.push(`${file.name} (not a text file)`);
      continue;
    }
    added.push({ id: crypto.randomUUID(), name: file.name, size: file.size, content });
  }
  return { added, skipped };
}

/** How the two surfaces word what they left out, so the sentence does not drift between them. */
export const skippedAttachmentNote = (skipped: readonly string[]): string =>
  skipped.length ? `Skipped ${skipped.join(', ')}` : '';
