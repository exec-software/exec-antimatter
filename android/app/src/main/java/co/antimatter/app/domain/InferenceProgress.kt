package co.antimatter.app.domain

import java.text.NumberFormat

enum class InferencePhase { STARTED, PREFILL, STREAMING, COMPLETE }

data class PromptProgress(
    val total: Long,
    val cached: Long,
    /** Includes the cached prefix, as reported by the source. */
    val processed: Long,
    val elapsedMs: Double,
)

data class TurnInference(
    val round: Int,
    val phase: InferencePhase,
    val requestStartedAt: Double,
    val requestDurationMs: Double,
    val promptProgress: PromptProgress? = null,
    val promptTokens: Long? = null,
    val cachedPromptTokens: Long? = null,
    val prefillTokens: Long? = null,
    val firstTokenMs: Double? = null,
)

/** Snapshots and ordinary context updates must not roll back a newer tool-loop request. */
fun latestInference(previous: TurnInference?, incoming: TurnInference?): TurnInference? {
    if (incoming == null) return previous
    if (previous == null) return incoming
    if (incoming.round != previous.round) return if (incoming.round > previous.round) incoming else previous
    if (incoming.requestStartedAt != previous.requestStartedAt) {
        return if (incoming.requestStartedAt > previous.requestStartedAt) incoming else previous
    }
    if (incoming.requestDurationMs < previous.requestDurationMs || incoming.phase.ordinal < previous.phase.ordinal) return previous
    return incoming
}

data class InferenceStatus(val label: String, val detail: String? = null, val progress: Float? = null)

fun inferenceStatus(turn: ActiveTurn?): InferenceStatus {
    if (turn?.cancellationRequested == true) return InferenceStatus("Stopping")
    if (turn?.waiting == true) return InferenceStatus("Waiting on agents")
    val metrics = turn?.inference ?: return InferenceStatus("Thinking")
    val numbers = NumberFormat.getIntegerInstance()
    val progress = metrics.promptProgress
    if (metrics.phase == InferencePhase.PREFILL) {
        return if (progress == null) InferenceStatus("Processing prompt", "Progress unreported") else InferenceStatus(
            label = "Processing prompt",
            detail = "${numbers.format(progress.processed)} / ${numbers.format(progress.total)} prompt tokens ready · " +
                "${numbers.format(progress.cached)} reused · ${numbers.format(progress.processed - progress.cached)} newly processed",
            progress = if (progress.total > 0) progress.processed.toFloat() / progress.total else null,
        )
    }
    return InferenceStatus(
        label = if (metrics.phase == InferencePhase.STARTED) "Waiting for reply" else "Working",
        detail = metrics.cachedPromptTokens?.let { "${numbers.format(it)} prompt tokens reused" },
    )
}
