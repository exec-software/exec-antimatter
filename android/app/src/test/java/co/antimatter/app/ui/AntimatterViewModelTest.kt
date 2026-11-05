package co.antimatter.app.ui

import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.ActiveTurn
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.ComposerDraft
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.InferenceModel
import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.RemoteWorkspace
import co.antimatter.app.domain.ThreadKey
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.remote.RemoteFailureCode
import co.antimatter.app.remote.RemoteWorkspaceException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AntimatterViewModelTest {
    @Test
    fun `switching workspaces never relabels a conversation or moves its draft`() {
        val key = ModelKey("provider", "model")
        val original = conversation("thread-a", "workspace-a", key)
        val viewModel = AntimatterViewModel(
            AntimatterUiState(
                conversations = listOf(original),
                activeConversationKey = original.threadKey,
                workspaces = listOf(workspace("workspace-a"), workspace("workspace-b")),
                activeWorkspaceId = "workspace-a",
                models = listOf(
                    InferenceModel("workspace-a", key, "A model", "Provider"),
                    InferenceModel("workspace-b", key, "B model", "Provider"),
                ),
                drafts = mapOf(original.threadKey to ComposerDraft("keep this draft")),
            ),
        )

        viewModel.selectWorkspace("workspace-b")
        val switched = viewModel.state.value

        assertEquals("workspace-a", switched.conversations.first { it.id == original.id }.workspaceId)
        assertEquals("keep this draft", switched.drafts.getValue(original.threadKey).text)
        assertEquals("workspace-b", switched.activeConversation?.workspaceId)
        assertNotEquals(original.threadKey, switched.activeConversationKey)

        viewModel.selectWorkspace("workspace-a")
        assertEquals(original.threadKey, viewModel.state.value.activeConversationKey)
        assertEquals("keep this draft", viewModel.state.value.draft.text)
    }

    @Test
    fun `selecting a model from another workspace starts a new thread`() {
        val oldKey = ModelKey("provider", "old")
        val newKey = ModelKey("provider", "new")
        val original = conversation("thread-a", "workspace-a", oldKey)
        val viewModel = AntimatterViewModel(
            AntimatterUiState(
                conversations = listOf(original),
                activeConversationKey = original.threadKey,
                workspaces = listOf(workspace("workspace-a"), workspace("workspace-b")),
                activeWorkspaceId = "workspace-b",
                models = listOf(InferenceModel("workspace-b", newKey, "New model", "Provider")),
            ),
        )

        viewModel.selectModel(newKey)
        val changed = viewModel.state.value

        assertEquals(oldKey, changed.conversations.first { it.id == original.id }.model)
        assertEquals("workspace-a", changed.conversations.first { it.id == original.id }.workspaceId)
        assertEquals("workspace-b", changed.activeConversation?.workspaceId)
        assertEquals(newKey, changed.activeConversation?.model)
        assertNotEquals(original.threadKey, changed.activeConversationKey)
    }

    @Test
    fun `conversation model picker stays scoped to the conversation workspace`() {
        val originalKey = ModelKey("provider", "old")
        val replacementKey = ModelKey("provider", "new")
        val original = conversation("thread-a", "workspace-a", originalKey)
        val viewModel = AntimatterViewModel(
            AntimatterUiState(
                conversations = listOf(original),
                activeConversationKey = original.threadKey,
                workspaces = listOf(workspace("workspace-a"), workspace("workspace-b")),
                activeWorkspaceId = "workspace-b",
                models = listOf(
                    InferenceModel("workspace-a", replacementKey, "A model", "Provider"),
                    InferenceModel("workspace-b", replacementKey, "B model", "Provider"),
                ),
            ),
        )

        viewModel.showModelPicker(true)
        viewModel.selectModel(replacementKey)

        assertEquals(1, viewModel.state.value.conversations.size)
        assertEquals("workspace-a", viewModel.state.value.activeConversation?.workspaceId)
        assertEquals("A model", viewModel.state.value.activeModel?.name)
    }

    @Test
    fun `stop always cancels the active thread and preserves its typed draft`() {
        val key = ModelKey("provider", "model")
        val original = conversation("thread-a", "workspace-a", key)
        val activeTurn = ActiveTurn("workspace-a", original.id, "request", "response")
        val viewModel = AntimatterViewModel(
            AntimatterUiState(
                conversations = listOf(original),
                activeConversationKey = original.threadKey,
                workspaces = listOf(workspace("workspace-a")),
                activeWorkspaceId = "workspace-a",
                models = listOf(InferenceModel("workspace-a", key, "Model", "Provider")),
                drafts = mapOf(original.threadKey to ComposerDraft("keep this next message")),
                activeTurns = mapOf(original.threadKey to activeTurn),
            ),
        )

        viewModel.stopTurn()

        assertEquals(null, viewModel.state.value.activeTurn)
        assertEquals("keep this next message", viewModel.state.value.draft.text)
    }

    @Test
    fun `event polling stops after revoked credentials`() {
        assertFalse(
            shouldRetryEventPolling(
                RemoteWorkspaceException(
                    code = RemoteFailureCode.AUTHENTICATION,
                    message = "Pair this device again.",
                    retryable = false,
                    httpStatus = 401,
                ),
            ),
        )
    }

    @Test
    fun `event polling retries transient network failures`() {
        assertTrue(
            shouldRetryEventPolling(
                RemoteWorkspaceException(
                    code = RemoteFailureCode.NETWORK,
                    message = "Host temporarily unreachable.",
                    retryable = true,
                ),
            ),
        )
    }

    @Test
    fun `command retries are limited to ambiguous retryable transport failures`() {
        assertTrue(
            shouldRetryRemoteCommand(
                RemoteWorkspaceException(RemoteFailureCode.NETWORK, "Response was lost.", retryable = true),
            ),
        )
        assertTrue(
            shouldRetryRemoteCommand(
                RemoteWorkspaceException(
                    RemoteFailureCode.HOST_UNAVAILABLE,
                    "Temporary host failure.",
                    retryable = true,
                    httpStatus = 503,
                ),
            ),
        )
        assertFalse(
            shouldRetryRemoteCommand(
                RemoteWorkspaceException(RemoteFailureCode.CONFLICT, "Refresh first.", retryable = true, httpStatus = 409),
            ),
        )
        assertFalse(
            shouldRetryRemoteCommand(
                RemoteWorkspaceException(RemoteFailureCode.NETWORK, "Permanent.", retryable = false),
            ),
        )
    }

    @Test
    fun `host refresh requests the open transcript only from its owning host`() {
        val key = ModelKey("provider", "model")
        val open = conversation("thread-a", "workspace-a", key)
        val state = AntimatterUiState(
            conversations = listOf(open),
            activeConversationKey = open.threadKey,
            workspaces = listOf(workspace("workspace-a"), workspace("workspace-b")),
            activeWorkspaceId = "workspace-a",
        )

        assertEquals("thread-a", selectedThreadIdForHost(state, "workspace-a"))
        assertEquals(null, selectedThreadIdForHost(state, "workspace-b"))
    }

    @Test
    fun `identical thread ids on two hosts keep selection drafts and turns isolated`() {
        val model = ModelKey("provider", "model")
        val laptop = conversation("shared-thread", "workspace-a", model)
        val studio = conversation("shared-thread", "workspace-b", model)
        val laptopKey = ThreadKey("workspace-a", "shared-thread")
        val studioKey = ThreadKey("workspace-b", "shared-thread")
        val laptopTurn = ActiveTurn("workspace-a", "shared-thread", "request-a", "response-a")
        val studioTurn = ActiveTurn("workspace-b", "shared-thread", "request-b", "response-b")
        val viewModel = AntimatterViewModel(
            AntimatterUiState(
                conversations = listOf(laptop, studio),
                activeConversationKey = laptopKey,
                workspaces = listOf(workspace("workspace-a"), workspace("workspace-b")),
                models = listOf(
                    InferenceModel("workspace-a", model, "Laptop model", "Provider"),
                    InferenceModel("workspace-b", model, "Studio model", "Provider"),
                ),
                drafts = mapOf(
                    laptopKey to ComposerDraft("laptop draft"),
                    studioKey to ComposerDraft("studio draft"),
                ),
                activeTurns = mapOf(laptopKey to laptopTurn, studioKey to studioTurn),
            ),
        )

        viewModel.selectConversation(studioKey)
        viewModel.updateDraft("studio changed")
        viewModel.stopTurn()

        val changed = viewModel.state.value
        assertEquals(studioKey, changed.activeConversationKey)
        assertEquals("workspace-b", changed.activeConversation?.hostId)
        assertEquals("laptop draft", changed.drafts.getValue(laptopKey).text)
        assertEquals("studio changed", changed.drafts.getValue(studioKey).text)
        assertEquals("request-a", changed.activeTurns[laptopKey]?.requestId)
        assertFalse(changed.activeTurns.containsKey(studioKey))
    }

    @Test
    fun `numeric thread revisions never move backwards`() {
        assertTrue(revisionAtLeast("12", "11"))
        assertTrue(revisionAtLeast("12", "12"))
        assertFalse(revisionAtLeast("11", "12"))
        assertFalse(revisionAtLeast(null, "12"))
    }

    private fun workspace(id: String) = RemoteWorkspace(
        id = id,
        name = id,
        baseUrl = "https://$id.example",
        phase = ConnectionPhase.ONLINE,
        detail = "Online",
        capabilities = setOf(WorkspaceCapability.CHAT),
    )

    private fun conversation(id: String, workspaceId: String, model: ModelKey) = Conversation(
        id = id,
        title = id,
        project = "Inbox",
        workspaceId = workspaceId,
        model = model,
        accessMode = AccessMode.ASK,
        pinned = false,
        updatedAtMillis = 1,
        messages = emptyList(),
    )
}
