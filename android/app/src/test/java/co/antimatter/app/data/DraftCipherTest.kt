package co.antimatter.app.data

import co.antimatter.app.domain.ThreadKey
import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test

class DraftCipherTest {
    private val secret = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val identity = ThreadKey("host-a", "thread-a")

    @Test fun `draft ciphertext roundtrips unicode and long messages with randomized IVs`() {
        val text = "Private draft 🔒\n".repeat(5_000)
        val one = DraftCipher.encrypt(identity, text, secret)
        val two = DraftCipher.encrypt(identity, text, secret)
        assertFalse(one.contentEquals(two))
        assertEquals(text, DraftCipher.decrypt(identity, one, secret))
        assertFalse(one.toString(Charsets.UTF_8).contains("Private draft"))
    }

    @Test fun `ciphertext cannot be transplanted to another host or thread`() {
        val blob = DraftCipher.encrypt(identity, "sensitive", secret)
        assertTrue(runCatching { DraftCipher.decrypt(ThreadKey("host-b", "thread-a"), blob, secret) }.isFailure)
        assertTrue(runCatching { DraftCipher.decrypt(ThreadKey("host-a", "thread-b"), blob, secret) }.isFailure)
    }

    @Test fun `tampering truncated trailing and oversized inputs fail closed`() {
        val blob = DraftCipher.encrypt(identity, "sensitive", secret)
        val tampered = blob.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertTrue(runCatching { DraftCipher.decrypt(identity, tampered, secret) }.isFailure)
        assertTrue(runCatching { DraftCipher.decrypt(identity, blob.copyOf(10), secret) }.isFailure)
        assertTrue(runCatching { DraftCipher.decrypt(identity, blob + byteArrayOf(0), secret) }.isFailure)
        assertTrue(runCatching { DraftCipher.encrypt(identity, "x".repeat(1024 * 1024 + 1), secret) }.isFailure)
    }
}
