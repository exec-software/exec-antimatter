package co.antimatter.app.remote

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingOfferTest {
    private val now = 1_700_000_000_000L
    private val secret = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE"
    private val certificate = "test certificate bytes".toByteArray()
    private val pin = "sha256/" + Base64.getEncoder().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(certificate),
    )

    @Test
    fun `strict scan-or-paste pairing code verifies fields and redacts one-time material`() {
        val offer = PairingOffer.parse(url(expires = now + 60_000), now).getOrThrow()

        assertEquals("host-1", offer.hostId)
        assertEquals("offer-1", offer.offerId)
        assertEquals("https://example.test:8443/remote", offer.endpoint.baseUrl)
        assertTrue(offer.certificatePin.matches(certificate))
        assertFalse(offer.toString().contains(secret))
        assertFalse(offer.toString().contains("offer-1"))
    }

    @Test
    fun `pairing code rejects expiry duplicate unknown fields and legacy deep links`() {
        assertTrue(PairingOffer.parse(url(expires = now), now).isFailure)
        assertTrue(PairingOffer.parse(url(now + 60_000) + "&host=other", now).isFailure)
        assertTrue(PairingOffer.parse(url(now + 60_000) + "&token=leak", now).isFailure)
        assertTrue(
            PairingOffer.parse(
                url(now + 60_000).replace("ANTIMATTER-PAIRING-V1?", "antimatter://pair?"),
                now,
            ).isFailure,
        )
    }

    @Test
    fun `pairing code requires the host's exact base64url secret shape`() {
        assertTrue(PairingOffer.parse(url(now + 60_000).replace(secret, secret.dropLast(1)), now).isFailure)
        assertTrue(PairingOffer.parse(url(now + 60_000).replace(secret, secret.dropLast(1) + "+"), now).isFailure)
    }

    @Test
    fun `certificate pin parser rejects wrong digest length`() {
        assertTrue(CertificatePin.parse("sha256/AAAA").isFailure)
        assertTrue(CertificatePin.parse(pin).isSuccess)
    }

    private fun url(expires: Long): String = buildString {
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
