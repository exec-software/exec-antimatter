package co.antimatter.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingClipboardPolicyTest {
    @Test
    fun `consumed pairing code clears only the unchanged clipboard value`() {
        assertTrue(shouldClearConsumedPairingCode("pairing-code", "pairing-code"))
        assertFalse(shouldClearConsumedPairingCode("pairing-code", "new clipboard content"))
        assertFalse(shouldClearConsumedPairingCode("pairing-code", null))
        assertFalse(shouldClearConsumedPairingCode("", ""))
    }
}
