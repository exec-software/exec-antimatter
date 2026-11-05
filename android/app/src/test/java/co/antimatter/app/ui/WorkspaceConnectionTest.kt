package co.antimatter.app.ui

import androidx.lifecycle.ViewModelStore
import co.antimatter.app.data.DraftStore
import co.antimatter.app.domain.*
import co.antimatter.app.remote.*
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkspaceConnectionTest {
    private val dispatcher = StandardTestDispatcher()
    private val owner = ViewModelStore()
    private val model = ModelKey("provider", "coder")
    private val endpoint = WorkspaceEndpoint.parse("My workstation", "https://127.0.0.1:43128").getOrThrow()
    private val credential = WorkspaceCredential.create("a".repeat(43), "device", "workspace").getOrThrow()
    private val saved = StoredHostCredential("host", endpoint, credential)

    @Before fun setUp() { Dispatchers.setMain(dispatcher) }
    @After fun tearDown() { owner.clear(); Dispatchers.resetMain() }

    private fun vm(store: MemoryStore, gateway: RemoteWorkspaceGateway, drafts: DraftStore? = null): AntimatterViewModel = AntimatterViewModel(
        gateway = gateway, credentialStore = store, storageDispatcher = dispatcher,
        draftStore = drafts,
    ).also { owner.put("app", it) }

    @Test fun `a fresh debug install opens pairing without a demo workspace`() = runTest(dispatcher) {
        val viewModel = vm(MemoryStore(), FakeGateway())
        runCurrent()
        assertEquals(AppDestination.WORKSPACES, viewModel.state.value.destination)
        assertTrue(viewModel.state.value.workspaces.isEmpty())
        assertTrue(viewModel.state.value.conversations.isEmpty())
        viewModel.newChat()
        assertTrue(viewModel.state.value.workspaceEditorOpen)
        assertTrue(viewModel.state.value.conversations.isEmpty())
    }

    @Test fun `restoring a saved computer selects real projects and its conversation`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertEquals("host", viewModel.state.value.activeWorkspaceId)
        assertEquals("project", viewModel.state.value.activeProjectId)
        assertEquals(ThreadKey("host", "thread"), viewModel.state.value.activeConversationKey)
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertFalse(viewModel.state.value.isRestoringHosts)
        assertFalse(viewModel.state.value.workspaces.any { it.isPreview })
    }

    @Test fun `offline saved computer remains visible and retry loads its workspace`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { connectError = networkFailure() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertEquals("My workstation", viewModel.state.value.workspaces.single().name)
        assertEquals(ConnectionPhase.ERROR, viewModel.state.value.workspaces.single().phase)
        assertFalse(viewModel.state.value.workspaces.single().requiresPairing)
        gateway.connectError = null
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertEquals(2, gateway.connectCount)
    }

    @Test fun `successful recovery clears its obsolete connection notice`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { connectError = networkFailure() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertEquals("Computer unreachable.", viewModel.state.value.notice)
        assertEquals("host", viewModel.state.value.connectionNoticeHostId)
        gateway.connectError = null
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertNull(viewModel.state.value.notice)
        assertNull(viewModel.state.value.connectionNoticeHostId)
    }

    @Test fun `recovery preserves an unrelated notice even when its text matches the connection error`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { connectError = networkFailure() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.notify("Computer unreachable.")
        gateway.connectError = null
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertEquals("Computer unreachable.", viewModel.state.value.notice)
        assertNull(viewModel.state.value.connectionNoticeHostId)
    }

    @Test fun `one host recovery and its old snackbar cannot clear another hosts identical error`() = runTest(dispatcher) {
        val otherEndpoint = WorkspaceEndpoint.parse("Other computer", "https://127.0.0.2:43128").getOrThrow()
        val base = FakeGateway().apply { connectError = networkFailure() }
        val gateway = object : RemoteWorkspaceGateway by base {
            override suspend fun connect(endpoint: WorkspaceEndpoint, credential: WorkspaceCredential): Result<RemoteHost> =
                if (endpoint.baseUrl == otherEndpoint.baseUrl) Result.failure(networkFailure()) else base.connect(endpoint, credential)
        }
        val viewModel = vm(MemoryStore(saved, StoredHostCredential("other-host", otherEndpoint, credential)), gateway)
        runCurrent()
        assertEquals("other-host", viewModel.state.value.connectionNoticeHostId)
        base.connectError = null
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.workspaces.first { it.id == "host" }.phase)
        assertEquals("Computer unreachable.", viewModel.state.value.notice)
        assertEquals("other-host", viewModel.state.value.connectionNoticeHostId)
        viewModel.dismissNotice("Computer unreachable.", "host")
        assertEquals("Computer unreachable.", viewModel.state.value.notice)
        assertEquals("other-host", viewModel.state.value.connectionNoticeHostId)
    }

    @Test fun `failed bootstrap after successful pairing retries the saved credential`() = runTest(dispatcher) {
        val store = MemoryStore()
        val gateway = FakeGateway().apply {
            snapshotError = networkFailure()
            onPair = { store.save(saved).getOrThrow() }
        }
        val viewModel = vm(store, gateway)
        runCurrent()
        assertTrue(viewModel.pairWorkspace(pairingCode()))
        runCurrent()
        assertEquals(AppDestination.WORKSPACES, viewModel.state.value.destination)
        assertEquals(ConnectionPhase.ERROR, viewModel.state.value.workspaces.single().phase)
        assertFalse(viewModel.state.value.workspaces.single().requiresPairing)
        assertNull(viewModel.state.value.pairingHostId)
        gateway.snapshotError = null
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertEquals(1, gateway.pairCount)
    }

    @Test fun `rejected pairing is visible and asks for a new code`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { pairError = networkFailure() }
        val viewModel = vm(MemoryStore(), gateway)
        runCurrent()
        viewModel.pairWorkspace(pairingCode())
        runCurrent()
        assertTrue(viewModel.state.value.workspaces.single().requiresPairing)
        assertEquals(AppDestination.WORKSPACES, viewModel.state.value.destination)
        assertNull(viewModel.state.value.activeConversationKey)
    }

    @Test fun `revoked connection asks for pairing instead of retrying forever`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply {
            connectError = RemoteWorkspaceException(RemoteFailureCode.AUTHENTICATION, "Device revoked.", false, 401)
        }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertTrue(viewModel.state.value.workspaces.single().requiresPairing)
        assertEquals(1, gateway.connectCount)
    }

    @Test fun `empty project uses host issued creation and never a temporary local thread`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { emptyProject = true }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertTrue(viewModel.state.value.conversations.isEmpty())
        viewModel.selectProject("host", "project")
        assertNull(viewModel.state.value.activeConversationKey)
        viewModel.newChat()
        runCurrent()
        assertEquals("project", gateway.lastCommand?.projectId)
        assertTrue(gateway.lastCommand is WorkspaceCommand.CreateThread)
        assertEquals(ThreadKey("host", "thread"), viewModel.state.value.activeConversationKey)
    }

    @Test fun `forget removes credentials catalogs drafts and host selection`() = runTest(dispatcher) {
        val store = MemoryStore(saved)
        val gateway = FakeGateway()
        val viewModel = vm(store, gateway)
        runCurrent()
        viewModel.updateDraft("private draft")
        viewModel.forgetWorkspace("host")
        runCurrent()
        assertTrue(store.list().getOrThrow().isEmpty())
        assertTrue(viewModel.state.value.workspaces.isEmpty())
        assertTrue(viewModel.state.value.projects.isEmpty())
        assertTrue(viewModel.state.value.conversations.isEmpty())
        assertTrue(viewModel.state.value.drafts.isEmpty())
        assertNull(viewModel.state.value.activeWorkspaceId)
        assertEquals(AppDestination.WORKSPACES, viewModel.state.value.destination)
    }

    @Test fun `startup credential enumeration cannot overwrite a new pairing`() = runTest(dispatcher) {
        val store = MemoryStore(saved)
        val gateway = FakeGateway()
        val viewModel = vm(store, gateway)
        store.onList = { viewModel.pairWorkspace(pairingCode()) }
        runCurrent()
        assertEquals(1, gateway.pairCount)
        assertEquals(0, gateway.connectCount)
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
    }

    @Test fun `a late transcript response cannot restore a forgotten workspace`() = runTest(dispatcher) {
        val store = MemoryStore(saved)
        val gateway = FakeGateway()
        val viewModel = vm(store, gateway)
        runCurrent()
        val response = CompletableDeferred<Unit>()
        gateway.snapshotWait = response
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        viewModel.forgetWorkspace("host")
        runCurrent()
        response.complete(Unit)
        runCurrent()
        assertTrue(viewModel.state.value.workspaces.isEmpty())
        assertTrue(viewModel.state.value.conversations.isEmpty())
        assertTrue(viewModel.state.value.projects.isEmpty())
    }

    @Test fun `reconnect completion respects a project selected while loading`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val response = CompletableDeferred<Unit>()
        gateway.snapshotWait = response
        viewModel.reconnectWorkspace("host")
        runCurrent()
        viewModel.selectProject("host", "other")
        response.complete(Unit)
        runCurrent()
        assertEquals("other", viewModel.state.value.activeProjectId)
        assertNull(viewModel.state.value.activeConversationKey)
    }

    @Test fun `retry preserves the mobile chat rather than the desktop active chat`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply {
            additionalConversation = Conversation("mobile-chat", "Mobile chat", "Other project", "host", model,
                AccessMode.ASK, false, 2, emptyList(), projectId = "other", revision = "1")
        }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.selectConversation(ThreadKey("host", "mobile-chat"))
        runCurrent()
        viewModel.navigate(AppDestination.WORKSPACES)
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals("mobile-chat", gateway.snapshotRequests.last())
        assertEquals(ThreadKey("host", "mobile-chat"), viewModel.state.value.activeConversationKey)
        assertEquals("other", viewModel.state.value.activeProjectId)
        assertEquals(AppDestination.WORKSPACES, viewModel.state.value.destination)
    }

    @Test fun `retry preserves an empty project selected before reconnecting`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.selectProject("host", "other")
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals("other", viewModel.state.value.activeProjectId)
        assertNull(viewModel.state.value.activeConversationKey)
        assertEquals(AppDestination.CHAT, viewModel.state.value.destination)
    }

    @Test fun `choosing a model starts the chat in the selected empty project`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { emptyProject = true }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.selectProject("host", "other")
        viewModel.navigate(AppDestination.MODELS)
        viewModel.selectModel(model)
        runCurrent()
        val command = gateway.lastCommand as WorkspaceCommand.CreateThread
        assertEquals("other", command.projectId)
        assertEquals(model, command.model)
        assertEquals("other", viewModel.state.value.activeProjectId)
    }

    @Test fun `failed forgetting leaves a recoverable connection and retry restarts polling`() = runTest(dispatcher) {
        val store = MemoryStore(saved).apply { removeError = IllegalStateException("Storage unavailable.") }
        val gateway = FakeGateway()
        val viewModel = vm(store, gateway)
        runCurrent()
        viewModel.forgetWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ERROR, viewModel.state.value.activeWorkspace?.phase)
        assertFalse(viewModel.state.value.activeWorkspace!!.requiresPairing)
        assertFalse(store.list().getOrThrow().isEmpty())
        assertEquals(0, gateway.activeEventCollectors)
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertEquals(1, gateway.activeEventCollectors)
    }

    @Test fun `conversation rename pin and delete use authoritative host state`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val key = ThreadKey("host", "thread")
        viewModel.renameConversation(key, "  Release planning  ")
        runCurrent()
        assertEquals("Release planning", (gateway.lastCommand as WorkspaceCommand.RenameThread).title)
        assertEquals("Release planning", viewModel.state.value.activeConversation?.title)
        viewModel.togglePinned(key)
        runCurrent()
        assertTrue(viewModel.state.value.activeConversation!!.pinned)
        viewModel.updateDraft("private draft")
        viewModel.deleteConversation(key)
        runCurrent()
        assertTrue(gateway.lastCommand is WorkspaceCommand.DeleteThread)
        assertTrue(viewModel.state.value.conversations.isEmpty())
        assertNull(viewModel.state.value.activeConversationKey)
        assertFalse(viewModel.state.value.drafts.containsKey(key))
        assertTrue(viewModel.state.value.pendingThreadChanges.isEmpty())
    }

    @Test fun `failed rename is not optimistically displayed and keeps the draft`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { commandError = IllegalStateException("Revision changed. Refresh and retry.") }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("keep me")
        viewModel.renameConversation(ThreadKey("host", "thread"), "Rejected title")
        runCurrent()
        assertEquals("Real chat", viewModel.state.value.activeConversation?.title)
        assertEquals("keep me", viewModel.state.value.draft.text)
        assertTrue(viewModel.state.value.notice!!.contains("Revision changed"))
        assertTrue(viewModel.state.value.pendingThreadChanges.isEmpty())
    }

    @Test fun `accepted but unapplied deletion stays visible`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { applyMetadataCommands = false }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.deleteConversation(ThreadKey("host", "thread"))
        runCurrent()
        assertEquals("Real chat", viewModel.state.value.activeConversation?.title)
    }

    @Test fun `duplicate metadata taps are serialized and sending is disabled while pending`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { commandWait = CompletableDeferred() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("next message")
        val key = ThreadKey("host", "thread")
        viewModel.renameConversation(key, "Renamed")
        viewModel.deleteConversation(key)
        runCurrent()
        assertEquals(1, gateway.sendCount)
        assertFalse(viewModel.state.value.canSend)
        gateway.commandWait!!.complete(Unit)
        runCurrent()
        assertTrue(viewModel.state.value.canSend)
    }

    @Test fun `project chat capability gates creation sending models and metadata`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { projectCapabilities = emptySet() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.newChat()
        viewModel.updateDraft("hello")
        assertFalse(viewModel.state.value.canSend)
        viewModel.send()
        viewModel.selectModel(model)
        viewModel.deleteConversation(ThreadKey("host", "thread"))
        runCurrent()
        assertEquals(0, gateway.sendCount)
    }

    @Test fun `offline model selection never sends a command`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        gateway.connectError = networkFailure()
        viewModel.reconnectWorkspace("host")
        runCurrent()
        viewModel.selectModel(model)
        runCurrent()
        assertEquals(0, gateway.sendCount)
    }

    @Test fun `failed send restores its draft but never overwrites newer typing`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { commandError = IllegalStateException("Model unavailable") }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("first message")
        viewModel.send()
        runCurrent()
        assertEquals("first message", viewModel.state.value.draft.text)
        gateway.commandWait = CompletableDeferred()
        viewModel.send()
        runCurrent()
        viewModel.updateDraft("newer message")
        gateway.commandWait!!.complete(Unit)
        runCurrent()
        assertEquals("newer message", viewModel.state.value.draft.text)
    }

    @Test fun `unsent drafts survive recreation and only paired hosts are restored`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val credentials = MemoryStore(saved)
        val viewModel = vm(credentials, FakeGateway(), drafts)
        runCurrent()
        viewModel.updateDraft("Please preserve this offline draft 🔒")
        runCurrent()
        val key = ThreadKey("host", "thread")
        assertEquals("Please preserve this offline draft 🔒", drafts.values[key])
        drafts.values[ThreadKey("unpaired", "thread")] = "not authorized"
        owner.clear()
        val restarted = vm(credentials, FakeGateway(), drafts)
        runCurrent()
        assertEquals("Please preserve this offline draft 🔒", restarted.state.value.draft.text)
        assertFalse(restarted.state.value.drafts.keys.any { it.hostId == "unpaired" })
        assertEquals(setOf("host"), drafts.loadedHosts.toSet())
    }

    @Test fun `sending only clears saved draft after receipt and preserves newer typing`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val gateway = FakeGateway().apply { commandWait = CompletableDeferred() }
        val viewModel = vm(MemoryStore(saved), gateway, drafts)
        runCurrent()
        val key = ThreadKey("host", "thread")
        viewModel.updateDraft("first message")
        runCurrent()
        viewModel.send()
        runCurrent()
        assertEquals("first message", drafts.values[key])
        viewModel.updateDraft("next message")
        runCurrent()
        gateway.commandWait!!.complete(Unit)
        runCurrent()
        assertEquals("next message", drafts.values[key])
        owner.clear()
        val restarted = vm(MemoryStore(saved), FakeGateway(), drafts)
        runCurrent()
        restarted.send()
        runCurrent()
        assertFalse(drafts.values.containsKey(key))
    }

    @Test fun `rejected send and newer draft remain recoverable after restart`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val gateway = FakeGateway().apply { commandError = IllegalStateException("Model offline") }
        val credentials = MemoryStore(saved)
        val viewModel = vm(credentials, gateway, drafts)
        runCurrent()
        viewModel.updateDraft("retry this")
        runCurrent()
        viewModel.send()
        runCurrent()
        owner.clear()
        val restarted = vm(credentials, FakeGateway(), drafts)
        runCurrent()
        assertEquals("retry this", restarted.state.value.draft.text)
    }

    @Test fun `forget removes persisted drafts and stale queued writes cannot recreate them`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val viewModel = vm(MemoryStore(saved), FakeGateway(), drafts)
        runCurrent()
        viewModel.updateDraft("saved")
        runCurrent()
        viewModel.updateDraft("queued")
        viewModel.forgetWorkspace("host")
        runCurrent()
        assertTrue(drafts.values.isEmpty())
        assertTrue(viewModel.state.value.drafts.isEmpty())
    }

    @Test fun `deleting a thread clears its saved draft only after host confirms removal`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val gateway = FakeGateway().apply { applyMetadataCommands = false }
        val viewModel = vm(MemoryStore(saved), gateway, drafts)
        runCurrent()
        val key = ThreadKey("host", "thread")
        viewModel.updateDraft("unsent")
        runCurrent()
        viewModel.deleteConversation(key)
        runCurrent()
        assertEquals("unsent", drafts.values[key])
        gateway.applyMetadataCommands = true
        viewModel.deleteConversation(key)
        runCurrent()
        assertTrue(drafts.values.isEmpty())
    }

    @Test fun `draft persistence errors are visible and do not erase in memory text`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore().apply { saveError = IllegalStateException("Draft storage unavailable") }
        val viewModel = vm(MemoryStore(saved), FakeGateway(), drafts)
        runCurrent()
        viewModel.updateDraft("keep in memory")
        runCurrent()
        assertEquals("keep in memory", viewModel.state.value.draft.text)
        assertEquals("Draft storage unavailable", viewModel.state.value.notice)
    }

    @Test fun `queued text is still persisted when the computer reconnects`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val viewModel = vm(MemoryStore(saved), FakeGateway(), drafts)
        runCurrent()
        viewModel.updateDraft("keep through reconnect")
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals("keep through reconnect", drafts.values[ThreadKey("host", "thread")])
    }

    @Test fun `failed credential removal retains recoverable encrypted drafts`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val credentials = MemoryStore(saved).apply { removeError = IllegalStateException("Credential storage unavailable") }
        val viewModel = vm(credentials, FakeGateway(), drafts)
        runCurrent()
        viewModel.updateDraft("do not lose on failed forget")
        runCurrent()
        viewModel.forgetWorkspace("host")
        runCurrent()
        assertEquals("do not lose on failed forget", drafts.values[ThreadKey("host", "thread")])
        assertEquals(ConnectionPhase.ERROR, viewModel.state.value.activeWorkspace?.phase)
    }

    @Test fun `steering is deduplicated and never clears newer persisted draft text`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway, drafts)
        runCurrent()
        viewModel.updateDraft("start")
        runCurrent()
        viewModel.send()
        runCurrent()
        gateway.commandWait = CompletableDeferred()
        viewModel.updateDraft("steer")
        runCurrent()
        viewModel.submitSteer()
        viewModel.submitSteer()
        runCurrent()
        assertEquals(2, gateway.sendCount)
        viewModel.updateDraft("follow-up draft")
        runCurrent()
        gateway.commandWait!!.complete(Unit)
        runCurrent()
        assertEquals("follow-up draft", viewModel.state.value.draft.text)
        assertEquals("follow-up draft", drafts.values[ThreadKey("host", "thread")])
        viewModel.submitSteer()
        runCurrent()
        assertEquals("", viewModel.state.value.draft.text)
        assertTrue(drafts.values.isEmpty())
    }

    @Test fun `event gap waits for one snapshot before resuming from its accepted cursor`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        gateway.snapshotWait = gate
        gateway.snapshotCursor = EventCursor("epoch", 2)
        gateway.snapshotMessages = listOf(ChatMessage("response", MessageRole.ASSISTANT, "AB", 1))
        gateway.frames.send(delta(2, "B")) // Missing sequence1 requires a snapshot.
        gateway.frames.send(delta(3, "C"))
        runCurrent()
        assertEquals(2, gateway.snapshotRequests.size) // initial snapshot + exactly one recovery
        assertEquals(listOf(EventCursor("epoch", 0)), gateway.eventRequests)
        gate.complete(Unit)
        runCurrent()
        assertEquals("ABC", viewModel.state.value.activeConversation!!.messages.single().content)
        assertEquals(EventCursor("epoch", 2), gateway.eventRequests.last())
        gateway.frames.send(delta(3, "C"))
        runCurrent()
        assertEquals("ABC", viewModel.state.value.activeConversation!!.messages.single().content)
        assertEquals(1, gateway.activeEventCollectors)
    }

    @Test fun `failed invalidation reload retries before consuming more events`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("keep my draft")
        gateway.snapshotError = networkFailure()
        gateway.frames.send(WorkspaceStreamFrame.Event(WorkspaceEventEnvelope(
            1, "host", null, null, EventCursor("epoch", 1), "catalog.changed", WorkspaceEvent.CatalogChanged("2"),
        )))
        runCurrent()
        assertEquals(ConnectionPhase.ERROR, viewModel.state.value.activeWorkspace!!.phase)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(1, gateway.eventRequests.size)
        assertEquals(3, gateway.snapshotRequests.size)
        gateway.snapshotError = null
        gateway.snapshotCursor = EventCursor("epoch", 2)
        gateway.snapshotMessages = listOf(ChatMessage("response", MessageRole.ASSISTANT, "recovered", 1))
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace!!.phase)
        assertEquals("recovered", viewModel.state.value.activeConversation!!.messages.single().content)
        assertEquals("keep my draft", viewModel.state.value.draft.text)
        assertEquals(EventCursor("epoch", 2), gateway.eventRequests.last())
    }

    @Test fun `foreground recovery reconnects an offline paired computer without resending commands`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { connectError = networkFailure() }
        val credentials = MemoryStore(saved)
        val viewModel = vm(credentials, gateway)
        runCurrent()
        gateway.connectError = null
        viewModel.resumeConnections()
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace!!.phase)
        assertEquals(2, gateway.connectCount)
        assertEquals(0, gateway.sendCount)
        assertEquals(saved, credentials.load("host").getOrThrow())
    }

    @Test fun `foreground recovery never silently retries revoked credentials`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply {
            connectError = RemoteWorkspaceException(RemoteFailureCode.AUTHENTICATION, "Revoked", false)
        }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.resumeConnections()
        runCurrent()
        assertEquals(1, gateway.connectCount)
        assertTrue(viewModel.state.value.workspaces.single().requiresPairing)
    }

    @Test fun `changed known thread refreshes its transcript and active turn from another device`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        gateway.snapshotCursor = EventCursor("epoch", 1)
        gateway.snapshotMessages = listOf(ChatMessage("user", MessageRole.USER, "sent on desktop", 1))
        gateway.snapshotTurns = listOf(ActiveTurn("host", "thread", "run", "response", startedAtMillis = 1))
        gateway.frames.send(WorkspaceStreamFrame.Event(WorkspaceEventEnvelope(
            1, "host", "project", "thread", EventCursor("epoch", 1), "thread.changed",
            WorkspaceEvent.ThreadChanged(ConversationSummary("thread", "host", "project", "Real chat", false, false, 1, "2")),
        )))
        runCurrent()
        assertEquals("sent on desktop", viewModel.state.value.activeConversation!!.messages.single().content)
        assertEquals("run", viewModel.state.value.activeTurns[ThreadKey("host", "thread")]?.requestId)
        assertEquals(EventCursor("epoch", 1), gateway.eventRequests.last())
    }

    @Test fun `newer thread snapshot during reconnect cannot leave event polling stopped`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val stale = gateway.snapshot("host", "thread").getOrThrow()
        val pending = CompletableDeferred<WorkspaceSnapshot>()
        gateway.nextSnapshot = pending
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(0, gateway.activeEventCollectors)
        gateway.snapshotCursor = EventCursor("epoch", 2)
        gateway.snapshotMessages = listOf(ChatMessage("response", MessageRole.ASSISTANT, "AB", 1))
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        pending.complete(stale)
        runCurrent()
        assertEquals(1, gateway.activeEventCollectors)
        assertEquals(EventCursor("epoch", 2), gateway.eventRequests.last())
        gateway.frames.send(delta(3, "C"))
        runCurrent()
        assertEquals("ABC", viewModel.state.value.activeConversation!!.messages.single().content)
    }

    @Test fun `reconnect snapshot for old selection cannot skip newer selected transcript events`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply {
            additionalConversation = Conversation("second", "Second", "Antimatter", "host", model,
                AccessMode.ASK, false, 0, emptyList(), projectId = "project", revision = "1")
        }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        val stale = gateway.snapshot("host", "thread").getOrThrow().copy(cursor = EventCursor("epoch", 7))
        val pending = CompletableDeferred<WorkspaceSnapshot>()
        gateway.nextSnapshot = pending
        viewModel.reconnectWorkspace("host")
        runCurrent()
        gateway.snapshotCursor = EventCursor("epoch", 5)
        gateway.additionalConversation = gateway.additionalConversation!!.copy(
            messages = listOf(ChatMessage("response", MessageRole.ASSISTANT, "ABCDE", 1)))
        viewModel.selectConversation(ThreadKey("host", "second"))
        runCurrent()
        pending.complete(stale)
        runCurrent()
        assertEquals(ThreadKey("host", "second"), viewModel.state.value.activeConversationKey)
        assertEquals(EventCursor("epoch", 5), gateway.eventRequests.last())
        gateway.frames.send(delta(6, "F", "second"))
        gateway.frames.send(delta(7, "G", "second"))
        runCurrent()
        assertEquals("ABCDEFG", viewModel.state.value.activeConversation!!.messages.single().content)
        assertEquals(1, gateway.activeEventCollectors)
    }

    @Test fun `discarded invalidation snapshot must recover current selection before restarting events`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply {
            additionalConversation = Conversation("second", "Second", "Antimatter", "host", model,
                AccessMode.ASK, false, 0, emptyList(), projectId = "project", revision = "1")
        }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        val stale = gateway.snapshot("host", "thread").getOrThrow().copy(cursor = EventCursor("epoch", 3))
        val pending = CompletableDeferred<WorkspaceSnapshot>()
        gateway.nextSnapshot = pending
        gateway.frames.send(WorkspaceStreamFrame.Event(WorkspaceEventEnvelope(
            1, "host", null, null, EventCursor("epoch", 1), "catalog.changed", WorkspaceEvent.CatalogChanged("2"),
        )))
        runCurrent()
        gateway.snapshotError = networkFailure()
        viewModel.selectConversation(ThreadKey("host", "second"))
        runCurrent()
        pending.complete(stale)
        runCurrent()
        assertEquals(1, gateway.eventRequests.size)
        advanceTimeBy(100)
        runCurrent()
        assertEquals("second", gateway.snapshotRequests.last())
        assertEquals(1, gateway.eventRequests.size) // failed current-selection recovery still pauses replay
        gateway.snapshotError = null
        gateway.snapshotCursor = EventCursor("epoch", 2)
        gateway.additionalConversation = gateway.additionalConversation!!.copy(
            messages = listOf(ChatMessage("response", MessageRole.ASSISTANT, "AB", 1)))
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(EventCursor("epoch", 2), gateway.eventRequests.last())
        gateway.frames.send(delta(3, "C", "second"))
        runCurrent()
        assertEquals("ABC", viewModel.state.value.activeConversation!!.messages.single().content)
    }

    @Test fun `reconnect snapshot clears a completed run when its terminal event was missed`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply {
            snapshotTurns = listOf(ActiveTurn("host", "thread", "old", "response", projectId = "project"))
        }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertTrue(viewModel.state.value.isStreaming)
        gateway.snapshotTurns = emptyList()
        gateway.snapshotCursor = EventCursor("new-epoch", 0)
        viewModel.reconnectWorkspace("host")
        runCurrent()
        viewModel.updateDraft("next turn")
        assertNull(viewModel.state.value.activeTurn)
        assertTrue(viewModel.state.value.canSend)
        viewModel.send()
        runCurrent()
        assertEquals("next turn", (gateway.lastCommand as WorkspaceCommand.StartTurn).content)
    }

    @Test fun `snapshot predating send receipt preserves pending start but a later snapshot settles it`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { commandWait = CompletableDeferred() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("start")
        viewModel.send()
        runCurrent()
        val run = requireNotNull(viewModel.state.value.activeTurn)
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        assertEquals(run.requestId, viewModel.state.value.activeTurn?.requestId)
        val oldSnapshot = gateway.snapshot("host", "thread").getOrThrow()
        val pending = CompletableDeferred<WorkspaceSnapshot>()
        gateway.nextSnapshot = pending
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        gateway.commandWait!!.complete(Unit)
        runCurrent()
        pending.complete(oldSnapshot)
        runCurrent()
        assertEquals(run.requestId, viewModel.state.value.activeTurn?.requestId)
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        assertNull(viewModel.state.value.activeTurn)
    }

    @Test fun `reconnect clears an obsolete pending send even when its old request is cancelled`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val reply = CompletableDeferred<Result<CommandReceipt>>()
        gateway.nextCommandResult = reply
        viewModel.updateDraft("start")
        viewModel.send()
        runCurrent()
        assertNotNull(viewModel.state.value.activeTurn)
        viewModel.reconnectWorkspace("host")
        runCurrent()
        reply.cancel()
        runCurrent()
        assertNull(viewModel.state.value.activeTurn)
        viewModel.updateDraft("retry")
        assertTrue(viewModel.state.value.canSend)
        viewModel.send()
        runCurrent()
        assertNotNull(viewModel.state.value.activeTurn)
    }

    @Test fun `reconnect during ambiguous-command retry never resubmits through the new session`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { commandError = networkFailure() }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("start once")
        viewModel.send()
        runCurrent()
        assertEquals(1, gateway.sendCount)
        viewModel.reconnectWorkspace("host")
        runCurrent()
        advanceTimeBy(301)
        runCurrent()
        assertEquals(1, gateway.sendCount)
        assertNull(viewModel.state.value.activeTurn)
    }

    @Test fun `matching stream activity cancels start recovery and completion permits the next send`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("start")
        viewModel.send()
        runCurrent()
        val run = requireNotNull(viewModel.state.value.activeTurn)
        val snapshots = gateway.snapshotRequests.size
        gateway.frames.send(turnEvent(run, 1, WorkspaceEvent.Liveness(run.requestId, false)))
        runCurrent()
        advanceTimeBy(3_001)
        runCurrent()
        assertEquals(snapshots, gateway.snapshotRequests.size)
        assertEquals(run.requestId, viewModel.state.value.activeTurn?.requestId)
        gateway.frames.send(turnEvent(run, 2, WorkspaceEvent.TurnFinished(run.requestId, run.responseMessageId, "stop")))
        runCurrent()
        viewModel.updateDraft("another")
        assertTrue(viewModel.state.value.canSend)
        viewModel.send()
        runCurrent()
        assertEquals(2, gateway.sendCount)
    }

    @Test fun `unconfirmed accepted send refreshes once and trusts missing active turn`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("start")
        viewModel.send()
        runCurrent()
        val snapshots = gateway.snapshotRequests.size
        advanceTimeBy(3_001)
        runCurrent()
        assertEquals(snapshots + 1, gateway.snapshotRequests.size)
        assertNull(viewModel.state.value.activeTurn)
        assertFalse(viewModel.state.value.notice.orEmpty().contains("did not start"))
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(snapshots + 1, gateway.snapshotRequests.size)
    }

    @Test fun `stop waits for its pending start receipt before cancelling the host run`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val startReply = CompletableDeferred<Result<CommandReceipt>>()
        gateway.nextCommandResult = startReply
        viewModel.updateDraft("start")
        viewModel.send()
        runCurrent()
        val command = gateway.lastCommand as WorkspaceCommand.StartTurn
        viewModel.stopTurn()
        runCurrent()
        assertEquals(1, gateway.sendCount)
        assertTrue(viewModel.state.value.activeTurn!!.cancellationRequested)
        startReply.complete(Result.success(CommandReceipt(command.commandId, command.requestId, CommandDisposition.ACCEPTED)))
        runCurrent()
        assertEquals(2, gateway.sendCount)
        assertEquals(command.requestId, (gateway.lastCommand as WorkspaceCommand.CancelTurn).requestId)
    }

    @Test fun `steering waits for positive start confirmation without waiting for inference completion`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val startReply = CompletableDeferred<Result<CommandReceipt>>()
        gateway.nextCommandResult = startReply
        viewModel.updateDraft("start")
        viewModel.send()
        runCurrent()
        val command = gateway.lastCommand as WorkspaceCommand.StartTurn
        val run = requireNotNull(viewModel.state.value.activeTurn)
        viewModel.updateDraft("change direction")
        viewModel.submitSteer()
        runCurrent()
        assertEquals(1, gateway.sendCount)
        assertEquals("change direction", viewModel.state.value.draft.text)
        gateway.frames.send(turnEvent(run, 1, WorkspaceEvent.Liveness(run.requestId, false)))
        runCurrent()
        assertEquals(2, gateway.sendCount)
        assertEquals("change direction", (gateway.lastCommand as WorkspaceCommand.SteerTurn).note)
        assertEquals("", viewModel.state.value.draft.text)
        assertEquals(run.requestId, viewModel.state.value.activeTurn?.requestId)
        startReply.complete(Result.success(CommandReceipt(command.commandId, command.requestId, CommandDisposition.ACCEPTED)))
        runCurrent()
    }

    @Test fun `late failed stop cannot revive a finished run or replace the next run`() = runTest(dispatcher) {
        val run = ActiveTurn("host", "thread", "old", "response", projectId = "project")
        val gateway = FakeGateway().apply { snapshotTurns = listOf(run) }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val stopReply = CompletableDeferred<Result<CommandReceipt>>()
        gateway.nextCommandResult = stopReply
        viewModel.stopTurn()
        viewModel.stopTurn()
        runCurrent()
        assertEquals(1, gateway.sendCount)
        gateway.frames.send(turnEvent(run, 1, WorkspaceEvent.TurnFinished(run.requestId, run.responseMessageId, "stop")))
        runCurrent()
        viewModel.updateDraft("next")
        viewModel.send()
        runCurrent()
        viewModel.stopTurn()
        runCurrent()
        val next = requireNotNull(viewModel.state.value.activeTurn)
        assertEquals(3, gateway.sendCount)
        assertTrue(next.cancellationRequested)
        stopReply.complete(Result.failure(IllegalStateException("old cancellation failed")))
        runCurrent()
        assertEquals(next, viewModel.state.value.activeTurn)
        assertFalse(viewModel.state.value.notice.orEmpty().contains("old cancellation failed"))
    }

    @Test fun `already finished steering preserves draft and reconciles stale run`() = runTest(dispatcher) {
        val run = ActiveTurn("host", "thread", "old", "response", projectId = "project")
        val gateway = FakeGateway().apply { snapshotTurns = listOf(run) }
        val drafts = MemoryDraftStore()
        val viewModel = vm(MemoryStore(saved), gateway, drafts)
        runCurrent()
        gateway.snapshotTurns = emptyList()
        gateway.commandDisposition = CommandDisposition.ALREADY_FINISHED
        viewModel.updateDraft("keep this follow-up")
        viewModel.submitSteer()
        runCurrent()
        assertEquals("keep this follow-up", viewModel.state.value.draft.text)
        assertEquals("keep this follow-up", drafts.values[ThreadKey("host", "thread")])
        assertTrue(viewModel.state.value.canSend)
        assertNull(viewModel.state.value.activeTurn)
    }

    @Test fun `already finished stop reconciles stale turn without changing draft`() = runTest(dispatcher) {
        val run = ActiveTurn("host", "thread", "old", "response", projectId = "project")
        val gateway = FakeGateway().apply { snapshotTurns = listOf(run) }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        gateway.snapshotTurns = emptyList()
        gateway.commandDisposition = CommandDisposition.ALREADY_FINISHED
        viewModel.updateDraft("next")
        viewModel.stopTurn()
        runCurrent()
        assertNull(viewModel.state.value.activeTurn)
        assertEquals("next", viewModel.state.value.draft.text)
    }

    @Test fun `positive stream confirmation clears accepted saved draft even when both receipts are lost`() = runTest(dispatcher) {
        val drafts = MemoryDraftStore()
        val gateway = FakeGateway().apply { commandWait = CompletableDeferred() }
        val viewModel = vm(MemoryStore(saved), gateway, drafts)
        runCurrent()
        viewModel.updateDraft("accepted once")
        runCurrent()
        viewModel.send()
        runCurrent()
        val run = requireNotNull(viewModel.state.value.activeTurn)
        gateway.frames.send(turnEvent(run, 1, WorkspaceEvent.TextDelta(run.requestId, run.responseMessageId, "answer")))
        runCurrent()
        assertTrue(drafts.values.isEmpty())
        gateway.snapshotTurns = listOf(run)
        gateway.snapshotCursor = EventCursor("epoch", 1)
        gateway.commandError = networkFailure()
        gateway.commandWait!!.complete(Unit)
        runCurrent()
        advanceTimeBy(301)
        runCurrent()
        assertEquals(2, gateway.sendCount)
        assertEquals(run.requestId, viewModel.state.value.activeTurn?.requestId)
        assertEquals("", viewModel.state.value.draft.text)
        assertTrue(drafts.values.isEmpty())
    }

    @Test fun `failed send does not schedule accepted-turn recovery`() = runTest(dispatcher) {
        val gateway = FakeGateway().apply { commandError = IllegalStateException("rejected") }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        viewModel.updateDraft("retry")
        viewModel.send()
        runCurrent()
        val snapshots = gateway.snapshotRequests.size
        advanceTimeBy(3_001)
        runCurrent()
        assertEquals(snapshots, gateway.snapshotRequests.size)
        assertEquals("retry", viewModel.state.value.draft.text)
        assertNull(viewModel.state.value.activeTurn)
    }

    @Test fun `late failed reconnect bootstrap cannot replace a newer online snapshot with error`() = runTest(dispatcher) {
        val gateway = FakeGateway()
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val pending = CompletableDeferred<Result<WorkspaceSnapshot>>()
        gateway.nextSnapshotResult = pending
        viewModel.reconnectWorkspace("host")
        runCurrent()
        gateway.snapshotCursor = EventCursor("epoch", 0)
        gateway.snapshotTurns = listOf(ActiveTurn("host", "thread", "run", "response", projectId = "project"))
        viewModel.selectConversation(ThreadKey("host", "thread"))
        runCurrent()
        pending.complete(Result.failure(networkFailure()))
        runCurrent()
        assertEquals(ConnectionPhase.ONLINE, viewModel.state.value.activeWorkspace?.phase)
        assertEquals(1, gateway.activeEventCollectors)
        assertEquals(EventCursor("epoch", 0), gateway.eventRequests.last())
        assertEquals("run", viewModel.state.value.activeTurn?.requestId)
        assertNull(viewModel.state.value.notice)
    }

    private fun turnEvent(run: ActiveTurn, sequence: Long, event: WorkspaceEvent) = WorkspaceStreamFrame.Event(WorkspaceEventEnvelope(
        1, run.workspaceId, run.projectId, run.threadId, EventCursor("epoch", sequence), "turn.event", event,
    ))

    @Test fun `inference is scoped to its active request and survives ordinary context updates`() = runTest(dispatcher) {
        val initial = TurnInference(0, InferencePhase.PREFILL, 100.0, 10.0, PromptProgress(1000, 600, 700, 9.0), 1000, 600, 100)
        val run = ActiveTurn("host", "thread", "run", "response", projectId = "project", inference = initial)
        val gateway = FakeGateway().apply { snapshotTurns = listOf(run) }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        assertEquals(initial, viewModel.state.value.activeTurn!!.inference)
        suspend fun update(sequence: Long, requestId: String, inference: TurnInference?) {
            gateway.frames.send(turnEvent(run, sequence, WorkspaceEvent.ContextUpdated(requestId, null, null, 300, 4096, inference)))
            runCurrent()
        }
        val next = initial.copy(requestDurationMs = 20.0, promptProgress = PromptProgress(1000, 600, 800, 19.0))
        update(1, run.requestId, next)
        update(2, run.requestId, null)
        update(3, "other-run", initial)
        assertEquals(next, viewModel.state.value.activeTurn!!.inference)
        val second = TurnInference(1, InferencePhase.STARTED, 200.0, 0.0)
        update(4, run.requestId, second)
        update(5, run.requestId, next)
        assertEquals(second, viewModel.state.value.activeTurn!!.inference)
        assertNull(viewModel.state.value.activeTurn!!.inference!!.cachedPromptTokens)
        gateway.frames.send(turnEvent(run, 6, WorkspaceEvent.TurnFinished(run.requestId, run.responseMessageId, null)))
        runCurrent()
        assertNull(viewModel.state.value.activeTurn)
    }

    @Test fun `reconnect snapshot cannot replace newer same-run prefill with older counts`() = runTest(dispatcher) {
        val initial = TurnInference(0, InferencePhase.PREFILL, 100.0, 10.0, PromptProgress(1000, 600, 700, 9.0))
        val run = ActiveTurn("host", "thread", "run", "response", projectId = "project", inference = initial)
        val gateway = FakeGateway().apply { snapshotTurns = listOf(run) }
        val viewModel = vm(MemoryStore(saved), gateway)
        runCurrent()
        val next = initial.copy(requestDurationMs = 20.0, promptProgress = PromptProgress(1000, 600, 900, 19.0))
        gateway.frames.send(turnEvent(run, 1, WorkspaceEvent.ContextUpdated(run.requestId, null, null, null, null, next)))
        runCurrent()
        gateway.snapshotCursor = EventCursor("epoch", 1)
        viewModel.reconnectWorkspace("host")
        runCurrent()
        assertEquals(next, viewModel.state.value.activeTurn!!.inference)
    }

    private fun delta(sequence: Long, content: String, threadId: String = "thread") = WorkspaceStreamFrame.Event(WorkspaceEventEnvelope(
        1, "host", "project", threadId, EventCursor("epoch", sequence), "text.delta",
        WorkspaceEvent.TextDelta("run", "response", content),
    ))

    private fun networkFailure() = RemoteWorkspaceException(RemoteFailureCode.NETWORK, "Computer unreachable.", true)

    private fun pairingCode(): String = "ANTIMATTER-PAIRING-V1?" + mapOf(
        "endpoint" to endpoint.baseUrl, "host" to "host", "offer" to "offer", "secret" to "a".repeat(43),
        "pin" to "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "expires" to (System.currentTimeMillis() + 120_000).toString(),
    ).entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, "UTF-8")}" }

    private class MemoryStore(vararg stored: StoredHostCredential) : WorkspaceCredentialStore {
        private val values = stored.associateBy { it.hostId }.toMutableMap()
        var onList: () -> Unit = {}
        var removeError: Throwable? = null
        override fun save(value: StoredHostCredential) = Result.success(Unit).also { values[value.hostId] = value }
        override fun load(hostId: String) = Result.success(values[hostId])
        override fun list() = Result.success(values.values.toList()).also { onList() }
        override fun remove(hostId: String): Result<Unit> = removeError?.let { Result.failure(it) }
            ?: Result.success(Unit).also { values.remove(hostId) }
    }

    private class MemoryDraftStore : DraftStore {
        val values = mutableMapOf<ThreadKey, String>()
        val loadedHosts = mutableListOf<String>()
        var saveError: Throwable? = null
        override fun loadHost(hostId: String): Result<Map<ThreadKey, String>> {
            loadedHosts += hostId
            return Result.success(values.filterKeys { it.hostId == hostId })
        }
        override fun saveText(key: ThreadKey, text: String): Result<Unit> {
            saveError?.let { return Result.failure(it) }
            if (text.isEmpty()) values.remove(key) else values[key] = text
            return Result.success(Unit)
        }
        override fun remove(key: ThreadKey) = Result.success(Unit).also { values.remove(key) }
        override fun removeHost(hostId: String) = Result.success(Unit).also { values.keys.removeAll { it.hostId == hostId } }
    }

    private inner class FakeGateway : RemoteWorkspaceGateway {
        var connectError: Throwable? = null
        var snapshotError: Throwable? = null
        var pairError: Throwable? = null
        var pairCount = 0
        var connectCount = 0
        var emptyProject = false
        var onPair: () -> Unit = {}
        var snapshotWait: CompletableDeferred<Unit>? = null
        var nextSnapshot: CompletableDeferred<WorkspaceSnapshot>? = null
        var nextSnapshotResult: CompletableDeferred<Result<WorkspaceSnapshot>>? = null
        var snapshotCursor = EventCursor("epoch", 0)
        var snapshotMessages = emptyList<ChatMessage>()
        var snapshotTurns = emptyList<ActiveTurn>()
        val frames = Channel<WorkspaceStreamFrame>(Channel.UNLIMITED)
        val eventRequests = mutableListOf<EventCursor?>()
        var lastCommand: WorkspaceCommand? = null
        var additionalConversation: Conversation? = null
        var createdProjectId = "project"
        val snapshotRequests = mutableListOf<String?>()
        var activeEventCollectors = 0
        var sendCount = 0
        var commandError: Throwable? = null
        var nextCommandResult: CompletableDeferred<Result<CommandReceipt>>? = null
        var commandDisposition = CommandDisposition.ACCEPTED
        var commandWait: CompletableDeferred<Unit>? = null
        var applyMetadataCommands = true
        var projectCapabilities = setOf(WorkspaceCapability.CHAT)
        var threadTitle = "Real chat"
        var threadPinned = false
        private fun host() = RemoteHost("host", "My workstation", endpoint.baseUrl, ConnectionPhase.ONLINE,
            "Connected", setOf(WorkspaceCapability.CHAT))
        private fun conversation() = Conversation("thread", threadTitle, "Antimatter", "host", model,
            AccessMode.ASK, threadPinned, 1, snapshotMessages, projectId = createdProjectId, revision = "1")
        override suspend fun pair(offer: PairingOffer, request: PairingRequest): Result<PairingResult> {
            pairCount++
            pairError?.let { return Result.failure(it) }
            onPair()
            return Result.success(PairingResult(host(), "workspace", emptyList(), credential,
                setOf(WorkspaceCapability.CHAT), 1, "alpha"))
        }
        override suspend fun connect(endpoint: WorkspaceEndpoint, credential: WorkspaceCredential): Result<RemoteHost> {
            connectCount++
            return connectError?.let { Result.failure(it) } ?: Result.success(host())
        }
        override suspend fun disconnect(hostId: String) = Result.success(Unit)
        override suspend fun snapshot(hostId: String, selectedThreadId: String?): Result<WorkspaceSnapshot> {
            snapshotRequests += selectedThreadId
            val result = nextSnapshotResult
            nextSnapshotResult = null
            if (result != null) return result.await()
            val pending = nextSnapshot
            nextSnapshot = null
            if (pending != null) return Result.success(pending.await())
            snapshotWait?.await()
            snapshotError?.let { return Result.failure(it) }
            val selected = additionalConversation?.takeIf { it.id == selectedThreadId } ?: conversation()
            val additionalSummary = additionalConversation?.let {
                ConversationSummary(it.id, "host", requireNotNull(it.projectId), it.title, it.pinned, it.archived,
                    it.updatedAtMillis, requireNotNull(it.revision), model = it.model)
            }
            return Result.success(WorkspaceSnapshot(host(), "workspace", 1, "alpha", "1",
                listOf(WorkspaceProject("project", "host", "Antimatter", revision = "1", isDefault = true, capabilities = projectCapabilities),
                    WorkspaceProject("other", "host", "Other project", revision = "1", capabilities = projectCapabilities)),
                listOf(InferenceModel("host", model, "Coder", "Provider")), listOfNotNull(additionalSummary),
                if (emptyProject) null else ThreadSnapshot("host", requireNotNull(selected.projectId), selected, "1"),
                snapshotTurns, snapshotCursor))
        }
        override suspend fun thread(hostId: String, projectId: String, threadId: String) =
            Result.success(ThreadSnapshot(hostId, projectId, conversation(), "1"))
        override suspend fun send(command: WorkspaceCommand): Result<CommandReceipt> {
            sendCount++
            lastCommand = command
            val result = nextCommandResult
            nextCommandResult = null
            if (result != null) return result.await()
            commandWait?.await()
            commandError?.let { return Result.failure(it) }
            if (command is WorkspaceCommand.CreateThread) { createdProjectId = command.projectId; emptyProject = false }
            if (applyMetadataCommands) when (command) {
                is WorkspaceCommand.RenameThread -> threadTitle = command.title
                is WorkspaceCommand.SetThreadPinned -> threadPinned = command.pinned
                is WorkspaceCommand.DeleteThread -> emptyProject = true
                else -> Unit
            }
            return Result.success(CommandReceipt(command.commandId, null, commandDisposition,
                "thread", (command as? WorkspaceCommand.CreateThread)?.clientThreadId, "1"))
        }
        override fun events(hostId: String, after: EventCursor?): Flow<WorkspaceStreamFrame> = flow {
            eventRequests += after
            activeEventCollectors++
            try { for (frame in frames) emit(frame) } finally { activeEventCollectors-- }
        }
        override suspend fun createAttachment(hostId: String, projectId: String, request: AttachmentUploadRequest): Result<AttachmentUpload> = error("unused")
        override suspend fun uploadAttachment(hostId: String, upload: AttachmentUpload, content: ByteArray): Result<RemoteAsset> = error("unused")
        override suspend fun fetchAsset(hostId: String, assetId: String): Result<AssetPayload> = error("unused")
    }
}
