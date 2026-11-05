package co.antimatter.app.remote

import co.antimatter.app.domain.InferencePhase
import org.junit.Assert.*
import org.junit.Test

class RemoteInferenceCodecTest {
    private val inference = """{"round":2,"phase":"prefill","requestStartedAt":100,"requestDurationMs":50,
        "promptProgress":{"total":1000,"cached":600,"processed":800,"elapsedMs":45.5},
        "promptTokens":1000,"cachedPromptTokens":600,"prefillTokens":200}"""

    private fun event(value: String?): WorkspaceEvent.ContextUpdated {
        val body = """{"kind":"events","events":[{"workspaceId":"workspace","cursor":{"epoch":"epoch","sequence":1},
            "event":{"kind":"context.updated","threadId":"thread","payload":{"requestId":"run"${value?.let { ",\"inference\":$it" } ?: ""}}}}]}"""
        val frame = RemoteJsonCodec.streamFrames(body, "host", "workspace").single() as WorkspaceStreamFrame.Event
        return frame.envelope.event as WorkspaceEvent.ContextUpdated
    }

    @Test fun `live progress uses exact reported counts while missing telemetry remains absent`() {
        val value = requireNotNull(event(inference).inference)
        assertEquals(2, value.round)
        assertEquals(InferencePhase.PREFILL, value.phase)
        assertEquals(600L, value.cachedPromptTokens)
        assertEquals(800L, value.promptProgress!!.processed)
        assertEquals(45.5, value.promptProgress!!.elapsedMs, 0.0)
        assertNull(value.firstTokenMs)
        assertNull(event(null).inference)
    }

    @Test fun `invalid counts do not manufacture a valid progress bar or break event replay`() {
        assertNull(event(inference.replace("\"processed\":800", "\"processed\":1200")).inference!!.promptProgress)
        assertNull(event(inference.replace("\"cached\":600", "\"cached\":900")).inference!!.promptProgress)
        assertNull(event(inference.replace("\"processed\":800", "\"processed\":800.5")).inference!!.promptProgress)
        assertNull(event(inference.replace("\"phase\":\"prefill\"", "\"phase\":\"unknown\"")).inference)
        assertNull(event(inference.replace("\"cachedPromptTokens\":600", "\"cachedPromptTokens\":-1")).inference!!.cachedPromptTokens)
        assertEquals(0L, event(inference.replace("\"cachedPromptTokens\":600", "\"cachedPromptTokens\":0")).inference!!.cachedPromptTokens)
    }

    @Test fun `bootstrap restores ongoing prefill after reconnect`() {
        val endpoint = WorkspaceEndpoint.parse("Host", "https://127.0.0.1:43128").getOrThrow()
        val snapshot = RemoteJsonCodec.snapshot("""{"protocolVersion":1,"host":{"id":"host","name":"Host"},
            "workspaceId":"workspace","cursor":{"epoch":"epoch","sequence":5},"activeTurns":[{
            "threadId":"thread","requestId":"run","responseMessageId":"response","inference":$inference}]}""", endpoint)
        assertEquals(600L, snapshot.activeTurns.single().inference!!.promptProgress!!.cached)
        assertEquals(InferencePhase.PREFILL, snapshot.activeTurns.single().inference!!.phase)
    }
}
