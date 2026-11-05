import { createContext, useContext } from 'react';
import type { ConversationPreview } from '../../lib/conversation';

export interface PreviewPanelValue {
  selected: ConversationPreview | null;
  previews: readonly ConversationPreview[];
  workspace: string | null;
  /** Changes reset transient browser navigation without remounting the surrounding app. */
  conversationId?: string | null;
  onSelect(preview: ConversationPreview): void;
  onClear(): void;
  /** A modal surface may temporarily need to cover the browser without destroying its session. */
  suspended?: boolean;
}

const PreviewPanelContext = createContext<PreviewPanelValue>({
  selected: null,
  previews: [],
  workspace: null,
  onSelect: () => {},
  onClear: () => {},
});

export const PreviewPanelProvider = PreviewPanelContext.Provider;
export const usePreviewPanel = (): PreviewPanelValue => useContext(PreviewPanelContext);
