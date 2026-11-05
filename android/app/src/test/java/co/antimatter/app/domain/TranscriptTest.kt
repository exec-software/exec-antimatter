package co.antimatter.app.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    @Test
    fun `tool activities remain beside the prose boundary that created them`() {
        val first = activity("first", 5)
        val second = activity("second", 5)
        val third = activity("third", 11)

        val parts = buildTranscriptParts("Hello world", listOf(first, second, third))

        assertEquals(
            listOf("text:0", "tools:5", "text:5", "tools:11"),
            parts.map { it.key },
        )
        assertEquals("Hello", (parts[0] as TranscriptPart.Text).text)
        assertEquals(listOf("first", "second"), (parts[1] as TranscriptPart.Tools).tools.map { it.callId })
        assertEquals(" world", (parts[2] as TranscriptPart.Text).text)
    }

    @Test
    fun `offsets use UTF-16 indexing just like desktop and Kotlin strings`() {
        val parts = buildTranscriptParts("A😀BC", listOf(activity("after-emoji", 3)))

        assertEquals("A😀", (parts[0] as TranscriptPart.Text).text)
        assertEquals("BC", (parts[2] as TranscriptPart.Text).text)
    }

    @Test
    fun `malformed offsets are clamped and legacy activity is explicit`() {
        val parts = buildTranscriptParts(
            "answer",
            listOf(activity("before", -50), activity("after", 500), activity("legacy", null)),
        )

        assertEquals("tools:0", parts.first().key)
        val legacy = parts.last() as TranscriptPart.Tools
        assertTrue(legacy.legacy)
        assertEquals("legacy", legacy.tools.single().callId)
    }

    @Test
    fun `restored live work is settled instead of showing a dead spinner`() {
        val restored = settleRestoredToolActivities(
            listOf(activity("running", 0).copy(status = ToolStatus.RUNNING, awaitingApproval = true)),
        ).single()

        assertEquals(ToolStatus.FAILED, restored.status)
        assertFalse(restored.awaitingApproval)
        assertEquals("Interrupted before this action finished.", restored.resultPreview)
    }

    private fun activity(callId: String, offset: Int?) = ToolActivity(
        callId = callId,
        requestId = "request",
        contentOffset = offset,
        serverName = "Workspace",
        toolName = "read_file",
        tier = ToolTier.READ,
        summary = "Read a file",
        argumentsPreview = "{}",
        status = ToolStatus.DONE,
    )
}
