package co.antimatter.app.remote

import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.AccessMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RemoteJsonCodecTest {
    @Test
    fun `slash-bearing catalog model identifiers are valid`() {
        assertEquals("org/nemotron-super", validateRemoteModelId("org/nemotron-super"))
    }

    @Test
    fun `desktop approval resolution values are accepted`() {
        assertEquals(ApprovalResolution.APPROVED, parseRemoteApprovalResolution("approved"))
        assertEquals(ApprovalResolution.DECLINED, parseRemoteApprovalResolution("declined"))
        // Keep older alpha hosts safe while the desktop producer moves from allowed to approved.
        assertEquals(ApprovalResolution.APPROVED, parseRemoteApprovalResolution("allowed"))
    }

    @Test
    fun `event protocol versions fail closed`() {
        assertEquals(REMOTE_PROTOCOL_VERSION, validateRemoteEventProtocolVersion(REMOTE_PROTOCOL_VERSION))
        assertThrows(IllegalArgumentException::class.java) { validateRemoteEventProtocolVersion(2) }
    }

    @Test
    fun `accepted command dispatch failures are typed`() {
        val event = remoteCommandFailure(
            commandId = "command-1",
            requestId = "request-1",
            code = "dispatch_failed",
            userMessage = "Refresh the workspace.",
            retryable = true,
        )

        assertEquals("command-1", event.commandId)
        assertEquals("request-1", event.requestId)
        assertEquals("dispatch_failed", event.code)
        assertEquals("Refresh the workspace.", event.userMessage)
        assertEquals(true, event.retryable)
    }

    @Test
    fun `model selection is a revisioned host command`() {
        val command = WorkspaceCommand.SetThreadModel(
            hostId = "host-1",
            projectId = "project-1",
            commandId = "command-1",
            threadId = "thread-1",
            expectedRevision = "7",
            model = ModelKey("provider-1", "org/nemotron-super"),
        )

        assertEquals("thread.set_model", workspaceCommandKind(command))
        assertEquals("7", command.expectedRevision)
        assertEquals("thread-1", command.threadId)
        assertEquals("org/nemotron-super", command.model.modelId)
    }

    @Test
    fun `turn start carries the exact conversation revision`() {
        val command = WorkspaceCommand.StartTurn(
            hostId = "host-1",
            projectId = "project-1",
            commandId = "command-1",
            threadId = "thread-1",
            requestId = "request-1",
            userMessageId = "user-1",
            responseMessageId = "response-1",
            expectedRevision = "17",
            model = ModelKey("provider-1", "org/nemotron-super"),
            content = "Continue.",
            attachmentIds = emptyList(),
            accessMode = AccessMode.ASK,
        )

        assertEquals("turn.start", workspaceCommandKind(command))
        assertEquals("17", workspaceCommandExpectedRevision(command))
        assertEquals("thread-1", command.threadId)
    }
}
