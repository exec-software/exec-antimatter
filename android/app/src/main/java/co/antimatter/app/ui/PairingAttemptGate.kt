package co.antimatter.app.ui

import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Allows one pairing exchange per ViewModel and prevents an older completion releasing a newer one. */
internal class PairingAttemptGate {
    private val activeAttempt = AtomicReference<String?>(null)

    fun tryStart(): String? {
        val attemptId = UUID.randomUUID().toString()
        return attemptId.takeIf { activeAttempt.compareAndSet(null, attemptId) }
    }

    fun finish(attemptId: String) {
        activeAttempt.compareAndSet(attemptId, null)
    }
}
