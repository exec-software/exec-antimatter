import type { ConversationSubagent } from '../../lib/conversation';
import type { Message } from '../../types';
import { ConversationCard } from './ConversationCard';
import { SubagentSheet } from './SubagentSheet';

interface Props {
  panelShown: boolean;
  panelWidth: number;
  sheetWidth: number;
  messages: Message[];
  isActive: boolean;
  taskId: string | null;
  subagent: ConversationSubagent | null;
  onOpenSubagent(taskId: string): void;
  onCloseSubagent(): void;
  onAttach(): void;
}

/** An explicitly opened run is available in every view; the transcript owns panelShown. */
export function ConversationOverlay({ panelShown, panelWidth, sheetWidth, messages, isActive, taskId,
  subagent, onOpenSubagent, onCloseSubagent, onAttach }: Props) {
  if (!panelShown && !taskId) return null;
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-3 top-3 flex min-w-0 flex-col items-end">
      {taskId ? (
        <SubagentSheet key={taskId} width={sheetWidth} taskId={taskId} subagent={subagent}
          turnIsActive={isActive && messages[messages.length - 1]?.id === subagent?.messageId}
          onClose={onCloseSubagent} />
      ) : (
        <ConversationCard width={panelWidth} messages={messages} isActive={isActive}
          onOpenSubagent={onOpenSubagent} onAttach={onAttach} />
      )}
    </div>
  );
}
