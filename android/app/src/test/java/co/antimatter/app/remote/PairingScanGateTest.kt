package co.antimatter.app.remote

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingScanGateTest {
    private val now = 1_700_000_000_000L
    private val secret = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE"
    private val pin = "sha256/" + Base64.getEncoder().encodeToString(
        MessageDigest.getInstance("SHA-256").digest("camera certificate".toByteArray()),
    )

    @Test
    fun `unrelated QR stays open and does not consume the one valid result`() {
        val gate = PairingScanGate()

        assertTrue(gate.evaluate("https://example.test/not-pairing", now) is PairingScanDecision.Reject)
        assertEquals(PairingScanDecision.Accept, gate.evaluate(code(now + 60_000), now))
        assertEquals(PairingScanDecision.Ignore, gate.evaluate(code(now + 60_000), now))
    }

    @Test
    fun `expired QR is rejected without preventing a refreshed code`() {
        val gate = PairingScanGate()

        val expired = gate.evaluate(code(now), now)
        assertTrue(expired is PairingScanDecision.Reject)
        assertTrue((expired as PairingScanDecision.Reject).guidance.contains("expired"))
        assertEquals(PairingScanDecision.Accept, gate.evaluate(code(now + 60_000), now))
    }

    @Test
    fun `missing barcode value is quietly ignored`() {
        assertEquals(PairingScanDecision.Ignore, PairingScanGate().evaluate(null, now))
    }

    private fun code(expires: Long): String = buildString {
        append("ANTIMATTER-PAIRING-V1?")
        append("endpoint=").append(encoded("https://example.test:8443/remote"))
        append("&host=host-1")
        append("&offer=offer-1")
        append("&secret=").append(encoded(secret))
        append("&pin=").append(encoded(pin))
        append("&expires=").append(expires)
    }

    private fun encoded(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
