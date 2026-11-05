/** Isolated preview UI: fake image/native-browser IPC; no application main or user files. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDisplacerTokens } from '../../renderer/src/displacer';
import { PreviewPanel } from '../../renderer/src/plugins/preview/PreviewPanel';
import { PreviewPanelProvider } from '../../renderer/src/plugins/preview/context';
import { ConversationUiProvider } from '../../renderer/src/components/chat/conversationUi';
import type { ConversationPreview } from '../../renderer/src/lib/conversation';
import type { PreviewPageState } from '../../renderer/src/types';

const sampleImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><rect width="800" height="520" rx="20" fill="#18201e"/><rect x="30" y="30" width="740" height="52" rx="8" fill="#26342f"/><circle cx="54" cy="56" r="5" fill="#91c0a7"/><text x="72" y="62" font-family="sans-serif" font-size="17" fill="#dceae2">Synthetic workspace image</text><rect x="30" y="104" width="214" height="386" rx="8" fill="#202c27"/><rect x="270" y="104" width="500" height="230" rx="8" fill="#344d40"/><text x="306" y="206" font-family="sans-serif" font-size="29" fill="#e5f4eb">Preview your work.</text><text x="306" y="244" font-family="sans-serif" font-size="17" fill="#b3d0bf">Websites and images, beside the agent.</text><rect x="270" y="360" width="235" height="130" rx="8" fill="#25362c"/><rect x="532" y="360" width="238" height="130" rx="8" fill="#25362c"/></svg>');
const previews: ConversationPreview[] = [
  { id: 'app', at: 3, kind: 'page', target: 'http://localhost:5173/', title: 'Development app' },
  { id: 'image-a', at: 2, kind: 'image', target: 'artifacts/desktop.png', title: 'Desktop screenshot', workspace: '/fixture' },
  { id: 'image-b', at: 1, kind: 'image', target: 'artifacts/mobile.png', title: 'Mobile screenshot', workspace: '/fixture' },
];
const metrics = { opens: [] as string[], closes: 0, bounds: null as null | { x: number; y: number; width: number; height: number }, images: [] as string[], reloaded: 0, history: [] as string[], failImages: false };
const listeners = new Set<(state: PreviewPageState) => void>();
let url = '';
const state = (error?: string): PreviewPageState => ({ url, title: 'Preview fixture', loading: false, canGoBack: true, canGoForward: true, error: error ?? null });
const emit = (error?: string) => { for (const listener of listeners) listener(state(error)); };
const surface = document.createElement('div');
surface.id = 'fake-native-preview';
surface.style.cssText = 'position:fixed;display:none;pointer-events:none;background:#151a19;color:#d8e7df;padding:28px;box-sizing:border-box;font:13px system-ui;z-index:20';
surface.innerHTML = '<span style="font-size:11px;color:#78a994;letter-spacing:1.5px">LOCAL DEVELOPMENT PREVIEW</span><h1 style="font-size:25px;font-weight:500;margin-top:24px">Build alongside the conversation.</h1><p style="color:#9dafaa;line-height:1.7">A sandboxed web surface, docked in Antimatter’s Preview tool window.</p><div style="margin-top:28px;border:1px solid #344a41;border-radius:8px;padding:18px;color:#83baa1">Isolated UI fixture · no network or workspace access</div>';
document.body.appendChild(surface);
window.electronAPI = {
  preview: {
    openPage: async (next: string) => { metrics.opens.push(next); url = next; emit(); },
    closePage: async () => { metrics.closes += 1; metrics.bounds = null; surface.style.display = 'none'; },
    bounds: (bounds: typeof metrics.bounds) => {
      metrics.bounds = bounds;
      surface.style.display = bounds ? 'block' : 'none';
      if (bounds) Object.assign(surface.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    },
    image: async (path: string, _workspace?: string, thumbnail?: boolean) => {
      metrics.images.push(`${thumbnail ? 'thumbnail' : 'image'}:${path}`);
      if (metrics.failImages) throw new Error('Fixture image unavailable');
      return { dataUrl: sampleImage, width: 800, height: 520, bytes: 1024, path, mimeType: 'image/svg+xml' };
    },
    reload: async () => { metrics.reloaded += 1; emit(); },
    back: async () => { metrics.history.push('back'); emit(); },
    forward: async () => { metrics.history.push('forward'); emit(); },
  },
  onPreviewPage: (listener: (next: PreviewPageState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
} as unknown as typeof window.electronAPI;

let controls: { select(preview: ConversationPreview | null): void; visible(value: boolean): void; suspend(value: boolean): void; conversation(value: string): void };
function Fixture() {
  const [selected, setSelected] = useState<ConversationPreview | null>(previews[0]);
  const [visible, setVisible] = useState(true);
  const [suspended, setSuspended] = useState(false);
  const [conversationId, setConversation] = useState('fixture-one');
  controls = { select: setSelected, visible: setVisible, suspend: setSuspended, conversation: setConversation };
  return <ConversationUiProvider value={{ activeWorkspace: '/fixture', openPreview: () => {}, openSubagent: () => {}, waitingOnAgents: false, reasoning: () => '' }}>
    <PreviewPanelProvider value={{ selected, previews, workspace: '/fixture', conversationId, suspended, onSelect: setSelected, onClear: () => setSelected(null) }}>
      <main className="flex h-screen bg-surface-0 text-ink">
        <div className="min-w-0 flex-1 p-8"><h1 className="text-xl font-medium">Antimatter</h1><p className="mt-3 text-sm text-ink-3">Preview lives beside the conversation.</p><p className="mt-2 max-w-sm text-xs leading-5 text-ink-3">Independent fixture · fake native browser surface and synthetic images · network and device access disabled.</p></div>
        <aside id="fixture-preview" className="flex min-h-0 flex-col border-l border-line bg-surface-1" style={{ width: 480 }}>
          <header className="flex h-9 shrink-0 items-center border-b border-line px-3 text-xs text-ink-2">Preview</header>
          <div className="min-h-0 flex-1"><PreviewPanel visible={visible} floating={false} /></div>
        </aside>
      </main>
    </PreviewPanelProvider>
  </ConversationUiProvider>;
}
Object.assign(window, { previewSmoke: { metrics, previews, emit,
  select: (index: number) => controls.select(index < 0 ? null : previews[index]),
  refreshImage: () => controls.select({ ...previews[1], id: 'image-refreshed' }),
  visible: (value: boolean) => controls.visible(value),
  suspend: (value: boolean) => controls.suspend(value),
  conversation: (value: string) => { controls.select(null); controls.conversation(value); },
  listeners: () => listeners.size,
} });
applyDisplacerTokens();
createRoot(document.getElementById('root')!).render(<Fixture />);
