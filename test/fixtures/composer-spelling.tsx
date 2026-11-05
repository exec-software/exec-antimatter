import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposer, type ChatComposerHandle } from '../../renderer/src/components/chat/ChatComposer';
import type { Draft } from '../../renderer/src/types';

const drafts: Record<string, Draft> = {
  first: { text: '', attachments: [{ id: 'note', name: 'notes.txt', content: 'keep this', size: 9 }] },
  second: { text: 'Other conversation', attachments: [] },
};
const submitted: string[] = [];
const steered: string[] = [];
function Fixture() {
  const composer = useRef<ChatComposerHandle>(null);
  const [threadId, setThreadId] = useState('first');
  const [streaming, setStreaming] = useState(false);
  const [revision, setRevision] = useState(0);
  Object.assign(window, { spellingSmoke: {
    drafts, submitted, steered,
    current: () => composer.current?.currentDraft(),
    flush: () => composer.current?.flushDraft(),
    switchThread: setThreadId,
    stream: setStreaming,
    rerender: () => setRevision((value) => value + 1),
  } });
  return <main data-revision={revision}>
    <ChatComposer key={threadId} ref={composer} threadId={threadId} draft={drafts[threadId]}
      onDraftChange={(id, draft) => { drafts[id] = draft; }}
      onSubmit={(text) => { submitted.push(text); return true; }} onSteer={(text) => steered.push(text)}
      streaming={streaming} onStop={() => {}} providers={[]} providerId="" modelId=""
      access={{ mode: 'ask', directory: null }} onChangeAccess={() => {}} onOpenModels={() => {}}
      workspace={null} workspaceConfirmed={false} onConfirmWorkspace={() => {}} />
    <textarea id="code" spellCheck={false} defaultValue="teh" />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
