package co.antimatter.app.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    @Test
    fun `model identity is scoped to its workspace as well as source and model`() {
        val repeatedKey = ModelKey("beholdd", "coder")
        val state = AntimatterUiState(
            conversations = listOf(
                Conversation(
                    id = "thread",
                    title = "Thread",
                    project = "Inbox",
                    workspaceId = "studio",
                    model = repeatedKey,
                    accessMode = AccessMode.ASK,
                    pinned = false,
                    updatedAtMillis = 1,
                    messages = emptyList(),
                ),
            ),
            activeConversationKey = ThreadKey("studio", "thread"),
            models = listOf(
                InferenceModel(
                    workspaceId = "laptop",
                    key = repeatedKey,
                    name = "Laptop coder",
                    providerName = "Laptop",
                ),
                InferenceModel(
                    workspaceId = "studio",
                    key = repeatedKey,
                    name = "Studio coder",
                    providerName = "Studio",
                ),
            ),
        )

        assertEquals("Studio coder", state.activeModel?.name)
    }

    @Test
    fun `chat authority follows its conversation and drafts remain thread scoped`() {
        val studio = RemoteWorkspace(
            id = "studio",
            name = "Studio",
            baseUrl = "https://studio.example",
            phase = ConnectionPhase.ONLINE,
            detail = "Online",
            capabilities = setOf(WorkspaceCapability.CHAT),
        )
        val laptop = studio.copy(id = "laptop", name = "Laptop")
        val activeConversation = conversation("thread", workspaceId = "studio", model = ModelKey("provider", "model")).copy(projectId = "project")
        val state = AntimatterUiState(
            conversations = listOf(activeConversation, conversation("other", "laptop", null)),
            activeConversationKey = ThreadKey("studio", "thread"),
            workspaces = listOf(studio, laptop),
            activeWorkspaceId = "laptop",
            projects = listOf(WorkspaceProject("project", "studio", "Project", revision = "1", capabilities = setOf(WorkspaceCapability.CHAT))),
            models = listOf(InferenceModel("studio", activeConversation.model!!, "Model", "Provider")),
            drafts = mapOf(
                ThreadKey("studio", "thread") to ComposerDraft("studio draft"),
                ThreadKey("laptop", "other") to ComposerDraft("laptop draft"),
            ),
        )

        assertEquals("studio", state.activeWorkspace?.id)
        assertEquals("studio draft", state.draft.text)
        assertTrue(state.canSend)
        assertFalse(state.copy(projects = emptyList()).canSend)
        assertFalse(state.copy(pendingThreadChanges = setOf(activeConversation.threadKey)).canSend)
        assertEquals("laptop draft", state.copy(activeConversationKey = ThreadKey("laptop", "other")).draft.text)
    }

    @Test
    fun `send fails closed without chat capability or a workspace scoped model`() {
        val key = ModelKey("provider", "model")
        val workspace = RemoteWorkspace(
            id = "studio",
            name = "Studio",
            baseUrl = "https://studio.example",
            phase = ConnectionPhase.ONLINE,
            detail = "Online",
            capabilities = setOf(WorkspaceCapability.FILES),
        )
        val state = AntimatterUiState(
            conversations = listOf(conversation("thread", "studio", key)),
            activeConversationKey = ThreadKey("studio", "thread"),
            workspaces = listOf(workspace),
            activeWorkspaceId = "studio",
            models = listOf(InferenceModel("other-host", key, "Wrong host", "Provider")),
            drafts = mapOf(ThreadKey("studio", "thread") to ComposerDraft("Hello")),
        )

        assertFalse(state.canSend)
        assertFalse(
            state.copy(
                workspaces = listOf(workspace.copy(capabilities = setOf(WorkspaceCapability.CHAT))),
            ).canSend,
        )
    }

    @Test
    fun `same thread id on two hosts keeps active conversation draft and turn isolated`() {
        val key = ModelKey("provider", "model")
        val laptop = conversation("shared-thread", "laptop", key)
        val studio = conversation("shared-thread", "studio", key)
        val laptopKey = laptop.threadKey
        val studioKey = studio.threadKey
        val state = AntimatterUiState(
            conversations = listOf(laptop, studio),
            activeConversationKey = studioKey,
            workspaces = listOf(
                RemoteWorkspace("laptop", "Laptop", "https://laptop.example", ConnectionPhase.ONLINE, "Online", setOf(WorkspaceCapability.CHAT)),
                RemoteWorkspace("studio", "Studio", "https://studio.example", ConnectionPhase.ONLINE, "Online", setOf(WorkspaceCapability.CHAT)),
            ),
            models = listOf(
                InferenceModel("laptop", key, "Laptop model", "Provider"),
                InferenceModel("studio", key, "Studio model", "Provider"),
            ),
            drafts = mapOf(
                laptopKey to ComposerDraft("laptop draft"),
                studioKey to ComposerDraft("studio draft"),
            ),
            activeTurns = mapOf(
                laptopKey to ActiveTurn("laptop", laptop.id, "laptop-request", "laptop-response"),
                studioKey to ActiveTurn("studio", studio.id, "studio-request", "studio-response"),
            ),
        )

        assertEquals("studio", state.activeConversation?.hostId)
        assertEquals("studio draft", state.draft.text)
        assertEquals("studio-request", state.activeTurn?.requestId)

        val switched = state.copy(activeConversationKey = laptopKey)
        assertEquals("laptop", switched.activeConversation?.hostId)
        assertEquals("laptop draft", switched.draft.text)
        assertEquals("laptop-request", switched.activeTurn?.requestId)
    }

    private fun conversation(id: String, workspaceId: String, model: ModelKey?): Conversation = Conversation(
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
