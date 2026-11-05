import { memo, useState } from 'react';
import { AGENT_REPORT, splitWork, startsAgent, unfinishedSubagents } from '../../lib/conversation';
import { buildVoiceTranscriptParts, voiceGuidanceStatusLabel, type VoiceTranscriptPart } from '../../lib/conversationVoice';
import { buildTranscriptParts } from '../../lib/transcript';
import type { Message } from '../../types';
import { AttachmentChip } from './AttachmentChip';
import { useConversationUi } from './conversationUi';
import { MarkdownContent } from './MarkdownContent';
import { SubagentReportRow, SubagentRow, WaitingForAgents } from './SubagentRow';
import { ThinkingTrace } from './ThinkingTrace';
import { ToolActivityCard } from './ToolActivityCard';
import { isVaultActivity, VaultActivityCard } from './VaultActivityCard';
import { isAskActivity, AskActivityCard } from './AskActivityCard';
import { WorkedFor } from './WorkedFor';

interface Props {
  message: Message;
  isActive?: boolean;
  /** Views that already display the actions can reuse prose without duplicating approvals. */
  showActions?: boolean;
}

/**
 * A message's prose and actions in the order they occurred during the turn.
 *
 * An assistant turn that did anything reads as two things: how it worked, folded to one line
 * once the turn is over, and the answer it wrote afterwards. The fold stays open while the turn
 * runs, when an action is waiting for approval, and when there is no answer to read instead.
 */
export function MessageBody(props: Props) {
  const { waitingOnAgents, reasoning, importedHistory } = useConversationUi();
  return <MessageBodyContent {...props}
    waitingOnAgents={Boolean(props.isActive && waitingOnAgents)}
    thinking={props.message.role === 'assistant' ? reasoning(props.message.id) : ''}
    importedHistory={Boolean(importedHistory)} />;
}

// Select this message's context values before memoizing: another run's thinking is unrelated.
const MessageBodyContent = memo(function MessageBodyContent({ message, isActive = false, showActions = true,
  waitingOnAgents, thinking, importedHistory,
}: Props & { waitingOnAgents: boolean; thinking: string; importedHistory: boolean }) {
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  const attachments = message.attachments ?? [];
  const tools = message.meta?.tools ?? [];
  const visibleTools = showActions ? tools : [];
  const parts = message.role === 'assistant' ? buildTranscriptParts(message.content, visibleTools) : [];
  const voiceParts = message.role === 'assistant' && message.meta?.voiceGuidance?.length
    ? buildVoiceTranscriptParts(message.content, visibleTools, message.meta.voiceGuidance) : [];
  const hasGuidance = voiceParts.some((part) => part.kind === 'voice');
  const { work, answer } = splitWork(parts);
  const hasActiveTool = tools.some(
    (activity) => activity.awaitingApproval || activity.status === 'pending' || activity.status === 'running'
  );
  const historical = Boolean(importedHistory && (
    message.meta?.sourceName === 'Imported Claude history' || message.meta?.sourceName === 'Imported Codex history'
    || message.meta?.sourceName === 'Imported OpenCode history'
  ));
  const thoughtTokens = message.meta?.reasoningTokens;
  const waitingFor = isActive && waitingOnAgents ? unfinishedSubagents(tools) : [];
  const waitingOnPerson = isActive && tools.some((activity) => activity.awaitingApproval);
  const hasAnswer = answer.some((part) => part.kind === 'text' && part.text.trim());
  const open = waitingOnPerson || (chosenOpen ?? (isActive || !hasAnswer));
  const hasVisibleTurn = Boolean(message.content || tools.length || hasGuidance);

  const renderPart = (part: VoiceTranscriptPart, tone: 'default' | 'muted') => {
    if (part.kind === 'voice') {
      return (
        <aside key={part.key} aria-label="Your spoken guidance" className="my-3 border-l-2 border-primary/40 pl-3">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-ink-2">
            <span className="font-medium text-ink">You · voice</span>
            <span>{voiceGuidanceStatusLabel(part.guidance.status, isActive)}</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{part.guidance.text}</div>
        </aside>
      );
    }
    if (part.kind === 'text') {
      return (
        <MarkdownContent
          key={part.key}
          content={part.text}
          fullContent={message.content}
          start={part.start}
          end={part.end}
          tone={tone}
        />
      );
    }

    const rows = part.tools.map((activity, index) => {
      const key = `${activity.activityId ?? activity.callId}:${index}`;
      if (startsAgent(activity)) return <SubagentRow key={key} activity={activity} isActive={isActive} />;
      if (activity.toolName === AGENT_REPORT) return <SubagentReportRow key={key} activity={activity} />;
      // A credential is not a tool call like the others; it gets its own card. See VaultActivityCard.
      if (isVaultActivity(activity)) return <VaultActivityCard key={key} activity={activity} isActive={isActive} />;
      // A question is the one card the person is expected to act on. See AskActivityCard.
      if (isAskActivity(activity)) return <AskActivityCard key={key} activity={activity} isActive={isActive} />;
      return <ToolActivityCard key={key} activity={activity} isActive={isActive} />;
    });

    if (part.legacy) {
      const count = part.tools.length;
      return (
        <details key={part.key} className="mt-3 border-l border-line-soft pl-3 text-ink-2">
          <summary className="cursor-pointer select-none py-1 text-xs text-ink-2 transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70">
            {count} action{count === 1 ? '' : 's'} from this earlier turn
          </summary>
          <p className="pb-1 text-[11px] leading-relaxed text-ink-2">
            This turn predates chronological activity, so the original positions were not recorded.
          </p>
          <div className="space-y-0.5">{rows}</div>
        </details>
      );
    }

    return (
      <div key={part.key} className="my-2 space-y-0.5 border-l border-line-soft pl-3">
        {rows}
      </div>
    );
  };

  return (
    <>
      {message.role === 'user' ? (
        message.content && <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{message.content}</div>
      ) : hasGuidance ? (
        // Human interjections should never disappear inside the collapsed work summary. Keep
        // their exact place alongside prose/actions; ordinary turns retain the compact fold.
        voiceParts.map((part) => renderPart(part, 'default'))
      ) : work.length ? (
        <>
          <WorkedFor
            historical={historical}
            startedAt={message.meta?.createdAt}
            finishedAt={message.meta?.finishedAt}
            failed={message.meta?.failed}
            actions={tools.length}
            isActive={isActive}
            open={open}
            onToggle={() => setChosenOpen(!open)}
          >
            {work.map((part) => renderPart(part, 'muted'))}
          </WorkedFor>
          {answer.map((part) => renderPart(part, 'default'))}
        </>
      ) : (
        parts.map((part) => renderPart(part, 'default'))
      )}

      {waitingFor.length > 0 ? (
        <div className={hasVisibleTurn ? 'mt-2' : ''}>
          <WaitingForAgents agents={waitingFor} />
        </div>
      ) : (isActive && !hasActiveTool) || thinking || thoughtTokens ? (
        // The deliberation belongs with the turn it explains, after its work and its answer,
        // and it is the whole of what a reasoning model does between tool calls.
        <div className={hasVisibleTurn ? 'mt-2' : ''}>
          <ThinkingTrace
            reasoning={thinking}
            recordedTokens={thoughtTokens}
            isActive={isActive && !hasActiveTool}
            idleLabel={hasVisibleTurn ? 'Thinking…' : 'Waiting for model output'}
          />
        </div>
      ) : null}

      {attachments.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 ${message.content || tools.length ? 'mt-2' : ''}`}>
          {attachments.map((attachment) => (
            <AttachmentChip key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </>
  );
});
