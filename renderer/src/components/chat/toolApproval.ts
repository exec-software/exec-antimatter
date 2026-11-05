import { useState } from 'react';
import type { ToolActivity } from '../../types';

/**
 * The approval half of a tool card, shared by the ordinary one and the Vault's.
 *
 * Extracted rather than copied because the states are fiddly and getting one wrong is a security
 * bug, not a cosmetic one: an approval that was already answered must not offer its buttons
 * again, an expired one must not look answerable, and a turn that died while waiting must not
 * leave a prompt that silently does nothing. Two cards reimplementing that drift apart.
 */
export interface ToolApproval {
  /** The prompt is live and the person has not answered it. */
  waiting: boolean;
  /** Answered in this window, and the answer is on its way or accepted. */
  submitted: boolean;
  choice: 'approved' | 'declined' | null;
  /** The run ended, or the approval was settled elsewhere, before an answer arrived. */
  expired: boolean;
  /** The owning turn is gone while this call was still unfinished. */
  interrupted: boolean;
  answering: boolean;
  error: string;
  answer(approved: boolean): Promise<void>;
}

export function useToolApproval(
  activity: ToolActivity,
  isActive: boolean,
  onAnswered?: () => void
): ToolApproval {
  const [choice, setChoice] = useState<'approved' | 'declined' | null>(null);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);

  const unfinished = activity.awaitingApproval || activity.status === 'pending' || activity.status === 'running';

  const answer = async (approved: boolean) => {
    setAnswering(true);
    setError('');
    setExpired(false);
    try {
      const accepted = await window.electronAPI.tools.approve(activity.approvalId ?? activity.callId, approved);
      if (!accepted) {
        setExpired(true);
      } else {
        setChoice(approved ? 'approved' : 'declined');
        onAnswered?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit this approval.');
      console.error(cause);
    } finally {
      setAnswering(false);
    }
  };

  return {
    waiting: isActive && !!activity.awaitingApproval && !choice && !expired,
    submitted: isActive && !!activity.awaitingApproval && choice !== null,
    choice,
    expired,
    interrupted: !isActive && unfinished,
    answering,
    error,
    answer,
  };
}
