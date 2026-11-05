import { reviewSnapshotLines, type CodeReview, type ReviewAnchor, type ReviewFile } from '../../../../src/api/codeReview';

export function anchorLabel(anchor: ReviewAnchor): string {
  return `${anchor.path}:${anchor.startLine}${anchor.endLine === anchor.startLine ? '' : `–${anchor.endLine}`} · ${anchor.side}`;
}

export function snapshotLines(file: ReviewFile, side: 'before' | 'after'): { number: number; text: string }[] {
  return reviewSnapshotLines(file[side]).map((line, index) => ({ number: (side === 'before' ? file.beforeStartLine : file.startLine) + index, text: line.replace(/\r$/, '') }));
}

export function reviewAgentPrompt(review: Pick<CodeReview, 'id' | 'title' | 'workspace'>): string {
  return `Collaborate with me on code review ${JSON.stringify(review.title)} (review ID: ${review.id}) in ${JSON.stringify(review.workspace)}. Use read_code_review to inspect the saved review, captured source, existing findings, and discussion; paginate source as needed. Review the captured code for concrete bugs and missing coverage. Use add_review_finding for actionable findings anchored to the saved before/after lines, reply_to_review to discuss existing findings, and update_review_finding to mark fixes addressed for my verification only when you have evidence the fix exists; proposed fixes remain open. Read the latest review revision before each change. Explain evidence and uncertainty, avoid duplicate findings, and do not edit source unless I ask. The snapshot may differ from current files; check freshness and never silently move an anchor. Final approval and verified resolution are mine.`;
}

export function selectionRange(start: number, line: number): Pick<ReviewAnchor, 'startLine' | 'endLine'> {
  return { startLine: Math.min(start, line), endLine: Math.max(start, line) };
}
