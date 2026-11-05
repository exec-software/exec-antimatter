# Connected chats

Open **Connected chats** in a chat header to connect it to another chat using the same selected project folder. Each connection grants both sessions access to the other's visible user and assistant messages and permission to send attributed notes. The connection persists until you disconnect the pair. Sidebar groups do not establish a shared project; both chats must have explicitly selected the same folder.

After connecting, ask an agent to coordinate relevant project work with the other chat. Its tools are:

- `list_connected_chats`: discover connected sessions and whether they are running.
- `read_chat`: read a bounded page of visible conversation text.
- `send_chat_message`: send a note under Ask first or Full access. Read only can read connected history but cannot send.

The connection is the standing permission, so individual reads and messages do not prompt again. Agents cannot create connections. Delegated subagents, scheduled work, orchestration jobs, and remote clients do not inherit a desktop chat's connection.

An active recipient receives notes between steps, without interrupting a tool or replacing human steering. An idle chat keeps its notes queued. Open its connections panel and choose **Continue with notes**, or send an ordinary message, to resume it. Continuing with notes preserves an unsent composer draft. Sending a note never starts an idle model or waits indefinitely for a reply.

The panel keeps sent and received notes separately from human chat messages, with sender, recipient, timestamp, and status. **Added to a turn** means the note was delivered to a recipient turn; it is not a read receipt or a promise that the model acted on it. Dismiss an unwanted queued note from the recipient's panel.

Disconnecting blocks future reads and sends and dismisses queued notes. Deleting either chat or changing its project folder also revokes the connection, even if the folder is later changed back. Previously delivered context cannot be removed from a model's past turn.

## Data and delivery boundaries

History sharing excludes system instructions, private reasoning, raw tool arguments and results, attachment contents, and unsent drafts. A peer's quoted user messages and requests arrive as untrusted tool data; they do not become the current user's instructions or permission approvals. Each recipient keeps its own task and access mode.

The host stores connections and notes in a private `chat-coordination.json` file in Electron's user-data directory, independently of conversation saves and imports. Notes are limited to 8 KiB, each recipient may have 64 queued notes, and the history retains up to 1,000 notes. Intake is bounded to 16 notes and 64 KiB per turn to keep active conversations from sustaining a message loop. Excess notes remain queued.

Sends use the host's source chat, run, and tool occurrence for provenance and duplicate suppression. A connection is checked again when a prepared call executes. Pending delivery claims are released on cancellation and recovered after restart; stable note identities prevent replay if a transcript checkpoint completed before its delivery receipt. The app preserves unreadable coordination state and disables the feature rather than breaking ordinary chat startup.
