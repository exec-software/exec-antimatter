package co.antimatter.app.domain

import co.antimatter.app.ui.AntimatterViewModel
import org.junit.Assert.*
import org.junit.Test

class FollowUpSuggestionTest {
    private val conversation = newConversation("host", null).copy(messages = listOf(
        ChatMessage("answer", MessageRole.ASSISTANT, "The feature is implemented.", 1),
    ))
    private fun state() = AntimatterUiState(conversations = listOf(conversation), activeConversationKey = conversation.threadKey)

    @Test fun `suggestion only fills draft and never starts a turn`() {
        val viewModel = AntimatterViewModel(state())
        val suggestion = viewModel.state.value.followUpSuggestion()!!
        viewModel.acceptFollowUpSuggestion(suggestion)
        assertEquals("Explain that in more detail.", viewModel.state.value.draft.text)
        assertTrue(viewModel.state.value.activeTurns.isEmpty())
        assertEquals(1, viewModel.state.value.activeConversation!!.messages.size)
        assertNull(viewModel.state.value.followUpSuggestion())
    }

    @Test fun `late acceptance never overwrites a draft including whitespace`() {
        val viewModel = AntimatterViewModel(state())
        val suggestion = viewModel.state.value.followUpSuggestion()!!
        viewModel.updateDraft(" ")
        viewModel.acceptFollowUpSuggestion(suggestion)
        assertEquals(" ", viewModel.state.value.draft.text)
    }

    @Test fun `suggestions are scoped to the exact conversation and message`() {
        val suggestion = state().followUpSuggestion()!!
        val other = conversation.copy(id = "another")
        val viewModel = AntimatterViewModel(state().copy(conversations = listOf(other), activeConversationKey = other.threadKey))
        viewModel.acceptFollowUpSuggestion(suggestion)
        assertEquals("", viewModel.state.value.draft.text)
        val newer = conversation.copy(messages = listOf(conversation.messages.single().copy(id = "new-answer")))
        val refreshed = AntimatterViewModel(state().copy(conversations = listOf(newer)))
        refreshed.acceptFollowUpSuggestion(suggestion)
        assertEquals("", refreshed.state.value.draft.text)
    }

    @Test fun `user drafts failures active turns attachments and user messages have no suggestion`() {
        val state = state()
        assertNull(state.copy(drafts = mapOf(conversation.threadKey to ComposerDraft("hello"))).followUpSuggestion())
        assertNull(state.copy(drafts = mapOf(conversation.threadKey to ComposerDraft(attachments = listOf(Attachment("a", "file", 1))))).followUpSuggestion())
        assertNull(state.copy(activeTurns = mapOf(conversation.threadKey to ActiveTurn("host", conversation.id, "run", "answer"))).followUpSuggestion())
        assertNull(state.copy(conversations = listOf(conversation.copy(messages = listOf(conversation.messages.single().copy(failed = true))))).followUpSuggestion())
        assertNull(state.copy(conversations = listOf(conversation.copy(messages = listOf(conversation.messages.single().copy(role = MessageRole.USER))))).followUpSuggestion())
    }

    @Test fun `tools suggest a summary but never approval of pending actions`() {
        val tool = ToolActivity("call", requestId = "run", serverName = "system", toolName = "edit", tier = ToolTier.WRITE,
            summary = "Edited file", argumentsPreview = "", status = ToolStatus.DONE)
        val withTool = state().copy(conversations = listOf(conversation.copy(messages = listOf(conversation.messages.single().copy(tools = listOf(tool))))))
        assertEquals("Summarize the changes and any remaining work.", withTool.followUpSuggestion()?.text)
        val pending = withTool.copy(conversations = listOf(conversation.copy(messages = listOf(conversation.messages.single().copy(tools = listOf(tool.copy(awaitingApproval = true)))))))
        assertNull(pending.followUpSuggestion())
    }
}
