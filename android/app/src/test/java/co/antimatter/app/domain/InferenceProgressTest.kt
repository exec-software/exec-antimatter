package co.antimatter.app.domain

import org.junit.Assert.*
import org.junit.Test

class InferenceProgressTest {
    private fun metrics(phase: InferencePhase = InferencePhase.PREFILL) = TurnInference(
        round = 1, phase = phase, requestStartedAt = 100.0, requestDurationMs = 50.0,
        promptProgress = PromptProgress(total = 100, cached = 60, processed = 80, elapsedMs = 40.0),
        promptTokens = 100, cachedPromptTokens = 60, prefillTokens = 20,
    )
    private fun turn(inference: TurnInference? = null) = ActiveTurn("host", "thread", "run", "response", inference = inference)

    @Test fun `prefill shows reported counts including the reused prefix`() {
        val status = inferenceStatus(turn(metrics()))
        assertEquals("Processing prompt", status.label)
        assertTrue(status.detail!!.contains("80 / 100 prompt tokens ready"))
        assertTrue(status.detail!!.contains("60 reused · 20 newly processed"))
        assertEquals(0.8f, status.progress!!, 0.001f)
    }

    @Test fun `unknown progress is not an estimated percentage or zero cache`() {
        val unknown = metrics(InferencePhase.STARTED).copy(promptProgress = null, cachedPromptTokens = null)
        assertNull(inferenceStatus(turn(unknown)).detail)
        assertNull(inferenceStatus(turn(unknown)).progress)
        val prefill = inferenceStatus(turn(unknown.copy(phase = InferencePhase.PREFILL)))
        assertEquals("Progress unreported", prefill.detail)
        assertNull(prefill.progress)
        assertNull(inferenceStatus(turn(metrics().copy(promptProgress = PromptProgress(0, 0, 0, 0.0)))).progress)
    }

    @Test fun `decode retains cache information but does not display stale prefill progress`() {
        val status = inferenceStatus(turn(metrics(InferencePhase.STREAMING)))
        assertEquals("Working", status.label)
        assertEquals("60 prompt tokens reused", status.detail)
        assertNull(status.progress)
        assertEquals("Waiting on agents", inferenceStatus(turn(metrics()).copy(waiting = true)).label)
        assertNull(inferenceStatus(turn(metrics()).copy(waiting = true)).progress)
    }

    @Test fun `new requests and snapshots cannot regress a newer inference reading`() {
        val streaming = metrics(InferencePhase.STREAMING)
        assertSame(streaming, latestInference(streaming, null))
        assertSame(streaming, latestInference(streaming, metrics().copy(requestDurationMs = 60.0)))
        assertSame(streaming, latestInference(streaming, streaming.copy(round = 0, requestStartedAt = 200.0)))
        assertSame(streaming, latestInference(streaming, streaming.copy(requestStartedAt = 99.0)))
        assertSame(streaming, latestInference(streaming, streaming.copy(requestDurationMs = 49.0)))
        val next = metrics(InferencePhase.STARTED).copy(round = 2, requestStartedAt = 200.0, promptProgress = null, cachedPromptTokens = null)
        assertSame(next, latestInference(streaming, next))
    }
}
