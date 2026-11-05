import { createContext, useContext } from 'react';

/**
 * What a transcript row can ask of the conversation around it.
 *
 * A subagent row lives several components below the view that owns the side panel; this is how
 * a click on it opens that agent's run there without threading a callback through every layer.
 */
export interface ConversationUi {
  assistantName?: string;
  /** Historical import text must not fetch embedded images just by being opened. */
  importedHistory?: boolean;
  openSubagent(taskId: string): void;
  /** Shows an image or page in the dockable Preview tool panel. */
  openPreview(preview: { kind: 'image' | 'page'; target: string; title: string; workspace?: string }): void;
  /** Main process workspace, used only to retry a bound image after a conversation switch. */
  activeWorkspace: string | null;
  /** The turn in flight has nothing to do until an agent it started reports. */
  waitingOnAgents: boolean;
  /**
   * What the model has thought so far on this message, or '' if it has not thought aloud.
   *
   * Held outside the thread so it is never persisted — see MessageMeta.reasoningTokens — and so
   * arriving thinking does not rebuild the transcript the way a content frame does.
   */
  reasoning(messageId: string): string;
}

const ConversationUiContext = createContext<ConversationUi>({
  openSubagent: () => undefined,
  openPreview: () => undefined,
  activeWorkspace: null,
  waitingOnAgents: false,
  reasoning: () => '',
});

export const ConversationUiProvider = ConversationUiContext.Provider;

export const useConversationUi = (): ConversationUi => useContext(ConversationUiContext);
