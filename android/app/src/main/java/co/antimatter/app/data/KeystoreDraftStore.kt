package co.antimatter.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import co.antimatter.app.domain.ThreadKey
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Stores unsent text only, never transcripts, attachments, QR material or provider credentials. */
interface DraftStore {
    fun loadHost(hostId: String): Result<Map<ThreadKey, String>>
    fun saveText(key: ThreadKey, text: String): Result<Unit>
    fun remove(key: ThreadKey): Result<Unit>
    fun removeHost(hostId: String): Result<Unit>
}

class KeystoreDraftStore(context: Context) : DraftStore {
    private val preferences = context.applicationContext.getSharedPreferences("antimatter_unsent_drafts", Context.MODE_PRIVATE)

    override fun loadHost(hostId: String): Result<Map<ThreadKey, String>> = runCatching {
        val prefix = "draft.${segment(hostId)}."
        preferences.all.keys.filter { it.startsWith(prefix) }.associate { storageKey ->
            val threadId = Base64.getUrlDecoder().decode(storageKey.removePrefix(prefix)).toString(Charsets.UTF_8)
            val key = ThreadKey(hostId, threadId)
            val blob = requireNotNull(preferences.getString(storageKey, null))
            key to DraftCipher.decrypt(key, Base64.getDecoder().decode(blob), secretKey())
        }
    }

    override fun saveText(key: ThreadKey, text: String): Result<Unit> = runCatching {
        if (text.isEmpty()) return@runCatching remove(key).getOrThrow()
        val blob = DraftCipher.encrypt(key, text, secretKey())
        check(preferences.edit().putString(storageKey(key), Base64.getEncoder().encodeToString(blob)).commit()) {
            "Your unsent draft could not be saved on this phone."
        }
    }

    override fun remove(key: ThreadKey): Result<Unit> = runCatching {
        check(preferences.edit().remove(storageKey(key)).commit()) { "The saved draft could not be cleared." }
    }

    override fun removeHost(hostId: String): Result<Unit> = runCatching {
        val prefix = "draft.${segment(hostId)}."
        val editor = preferences.edit()
        preferences.all.keys.filter { it.startsWith(prefix) }.forEach(editor::remove)
        check(editor.commit()) { "The computer's saved drafts could not be cleared." }
    }

    private fun storageKey(key: ThreadKey): String = "draft.${segment(requireNotNull(key.hostId))}.${segment(key.threadId)}"

    private fun segment(id: String): String {
        require(id.length in 1..128) { "The draft identity is invalid." }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(id.toByteArray(Charsets.UTF_8))
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
            generateKey()
        }
    }

    private companion object { const val KEY_ALIAS = "antimatter.unsent.drafts.v1" }
}

/** Host+thread associated data prevents valid ciphertext from being moved into another chat. */
internal object DraftCipher {
    private const val MAX_TEXT_BYTES = 1024 * 1024
    fun encrypt(key: ThreadKey, text: String, secret: SecretKey): ByteArray {
        val cleartext = text.toByteArray(Charsets.UTF_8)
        require(cleartext.size <= MAX_TEXT_BYTES) { "This draft is too large to save on this phone." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secret)
        cipher.updateAAD(identity(key))
        val encrypted = cipher.doFinal(cleartext)
        return ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(1)
                output.writeInt(cipher.iv.size)
                output.write(cipher.iv)
                output.writeInt(encrypted.size)
                output.write(encrypted)
            }
            bytes.toByteArray()
        }
    }

    fun decrypt(key: ThreadKey, blob: ByteArray, secret: SecretKey): String {
        require(blob.size <= MAX_TEXT_BYTES + 64) { "The encrypted draft is too large." }
        val (iv, ciphertext) = DataInputStream(ByteArrayInputStream(blob)).use { input ->
            require(input.readInt() == 1) { "The draft storage version is not supported." }
            val ivSize = input.readInt()
            require(ivSize == 12) { "The draft IV is invalid." }
            val iv = ByteArray(ivSize).also(input::readFully)
            val size = input.readInt()
            require(size in 16..MAX_TEXT_BYTES + 16) { "The encrypted draft length is invalid." }
            val ciphertext = ByteArray(size).also(input::readFully)
            require(input.read() == -1) { "The encrypted draft has trailing data." }
            iv to ciphertext
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, iv))
        cipher.updateAAD(identity(key))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun identity(key: ThreadKey): ByteArray = ByteArrayOutputStream().use { bytes ->
        DataOutputStream(bytes).use { output ->
            output.writeUTF(requireNotNull(key.hostId))
            output.writeUTF(key.threadId)
        }
        bytes.toByteArray()
    }
}
