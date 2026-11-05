package co.antimatter.app.remote

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Session-local policy for camera input. Raw QR contents remain caller-owned and are never retained
 * here; [PairingOffer] remains the single parser and trust boundary for both scan and paste paths.
 */
internal class PairingScanGate {
    private val accepted = AtomicBoolean(false)

    fun evaluate(rawValue: String?, nowMillis: Long = System.currentTimeMillis()): PairingScanDecision {
        if (accepted.get() || rawValue == null) return PairingScanDecision.Ignore
        val parsed = PairingOffer.parse(rawValue, nowMillis)
        if (parsed.isFailure) {
            val expired = parsed.exceptionOrNull()?.message?.contains("expired", ignoreCase = true) == true
            return PairingScanDecision.Reject(
                if (expired) {
                    "This pairing code expired. Generate a new QR code on the computer."
                } else {
                    "Keep the Antimatter pairing QR code inside the frame."
                },
            )
        }
        return if (accepted.compareAndSet(false, true)) PairingScanDecision.Accept else PairingScanDecision.Ignore
    }
}

internal sealed interface PairingScanDecision {
    data object Accept : PairingScanDecision
    data object Ignore : PairingScanDecision
    data class Reject(val guidance: String) : PairingScanDecision
}
