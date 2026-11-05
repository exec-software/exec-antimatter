package co.antimatter.app.domain

/** A local draft affordance, never an inferred authorization or an extra model request. */
data class FollowUpSuggestion(val thread: ThreadKey, val messageId: String, val text: String)

fun AntimatterUiState.followUpSuggestion(): FollowUpSuggestion? {
    val conversation = activeConversation ?: return null
    if (isStreaming || draft.text.isNotEmpty() || draft.attachments.isNotEmpty()) return null
    val message = conversation.messages.lastOrNull() ?: return null
    if (message.role != MessageRole.ASSISTANT || message.failed || message.content.isBlank()) return null
    if (conversation.messages.any { chat -> chat.tools.any {
            it.awaitingApproval || it.status == ToolStatus.PENDING || it.status == ToolStatus.RUNNING
        } }) return null
    return FollowUpSuggestion(
        conversation.threadKey,
        message.id,
        if (conversation.messages.any { it.tools.isNotEmpty() }) {
            "Summarize the changes and any remaining work."
        } else "Explain that in more detail.",
    )
}
