package co.antimatter.app.domain

sealed interface TranscriptPart {
    val key: String

    data class Text(
        override val key: String,
        val text: String,
        val start: Int,
        val end: Int,
    ) : TranscriptPart

    data class Tools(
        override val key: String,
        val tools: List<ToolActivity>,
        val offset: Int? = null,
        val legacy: Boolean = false,
    ) : TranscriptPart
}

/**
 * Places each tool occurrence at the UTF-16 text boundary emitted by the host. Calls sharing an
 * offset stay in first-seen order. Old activities without a trustworthy position are explicitly
 * grouped at the end instead of being drawn above an unrelated wall of text.
 */
fun buildTranscriptParts(
    content: String,
    tools: List<ToolActivity>,
): List<TranscriptPart> {
    val positioned = mutableListOf<IndexedValue<ToolActivity>>()
    val legacy = mutableListOf<ToolActivity>()

    tools.forEachIndexed { index, activity ->
        if (activity.contentOffset != null) positioned += IndexedValue(index, activity) else legacy += activity
    }

    val sorted = positioned.sortedWith(
        compareBy<IndexedValue<ToolActivity>> { it.value.contentOffset!!.coerceIn(0, content.length) }
            .thenBy { it.index },
    )

    val parts = mutableListOf<TranscriptPart>()
    var cursor = 0
    var index = 0
    while (index < sorted.size) {
        val offset = sorted[index].value.contentOffset!!.coerceIn(0, content.length)
        if (offset > cursor) {
            parts += TranscriptPart.Text(
                key = "text:$cursor",
                text = content.substring(cursor, offset),
                start = cursor,
                end = offset,
            )
        }

        val group = mutableListOf<ToolActivity>()
        while (
            index < sorted.size &&
            sorted[index].value.contentOffset!!.coerceIn(0, content.length) == offset
        ) {
            group += sorted[index].value
            index += 1
        }
        parts += TranscriptPart.Tools(key = "tools:$offset", tools = group, offset = offset)
        cursor = offset
    }

    if (cursor < content.length) {
        parts += TranscriptPart.Text(
            key = "text:$cursor",
            text = content.substring(cursor),
            start = cursor,
            end = content.length,
        )
    }
    if (legacy.isNotEmpty()) {
        parts += TranscriptPart.Tools(key = "tools:legacy", tools = legacy, legacy = true)
    }
    return parts
}

fun settleRestoredToolActivities(tools: List<ToolActivity>): List<ToolActivity> = tools.map { activity ->
    if (activity.status in setOf(ToolStatus.PENDING, ToolStatus.RUNNING) || activity.awaitingApproval) {
        activity.copy(
            status = ToolStatus.FAILED,
            awaitingApproval = false,
            resultPreview = activity.resultPreview ?: "Interrupted before this action finished.",
        )
    } else {
        activity
    }
}
