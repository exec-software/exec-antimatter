package co.antimatter.app.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
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

data class StoredHostCredential(
    val hostId: String,
    val endpoint: WorkspaceEndpoint,
    val credential: WorkspaceCredential,
)

interface WorkspaceCredentialStore {
    fun save(value: StoredHostCredential): Result<Unit>
    fun load(hostId: String): Result<StoredHostCredential?>
    fun list(): Result<List<StoredHostCredential>>
    fun remove(hostId: String): Result<Unit>
}

/**
 * Encrypts the complete device credential with a non-exportable Android Keystore AES-GCM key.
 * Preferences contain only randomized ciphertext; neither bearer material nor its certificate pin
 * is eligible for Android backup (the application also excludes all preferences from backup).
 */
class KeystoreCredentialStore(
    context: Context,
    private val keyAlias: String = "antimatter.remote.credentials.v1",
) : WorkspaceCredentialStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        "antimatter_remote_credentials",
        Context.MODE_PRIVATE,
    )

    override fun save(value: StoredHostCredential): Result<Unit> = runCatching {
        requireHostId(value.hostId)
        require(value.hostId == value.endpoint.name || value.endpoint.name.isNotBlank())
        val associatedData = value.hostId.toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(associatedData)
        val ciphertext = cipher.doFinal(encode(value))
        val blob = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(STORAGE_VERSION)
                output.writeInt(cipher.iv.size)
                output.write(cipher.iv)
                output.writeInt(ciphertext.size)
                output.write(ciphertext)
            }
            bytes.toByteArray()
        }
        check(preferences.edit().putString(storageKey(value.hostId), Base64.getEncoder().encodeToString(blob)).commit()) {
            "The encrypted credential could not be saved."
        }
    }

    override fun load(hostId: String): Result<StoredHostCredential?> = runCatching {
        requireHostId(hostId)
        val encoded = preferences.getString(storageKey(hostId), null) ?: return@runCatching null
        val blob = Base64.getDecoder().decode(encoded)
        val (iv, ciphertext) = DataInputStream(ByteArrayInputStream(blob)).use { input ->
            require(input.readInt() == STORAGE_VERSION) { "The credential storage version is not supported." }
            val iv = readBounded(input, MAX_IV_BYTES)
            val ciphertext = readBounded(input, MAX_CIPHERTEXT_BYTES)
            require(input.read() == -1) { "The encrypted credential has trailing data." }
            iv to ciphertext
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(hostId.toByteArray(Charsets.UTF_8))
        decode(cipher.doFinal(ciphertext)).also {
            require(it.hostId == hostId) { "The credential belongs to a different host." }
        }
    }

    override fun list(): Result<List<StoredHostCredential>> = runCatching {
        preferences.all.keys
            .asSequence()
            .filter { it.startsWith("host.") }
            .map { key ->
                val encodedHostId = key.removePrefix("host.")
                val hostId = Base64.getUrlDecoder().decode(encodedHostId).toString(Charsets.UTF_8)
                load(hostId).getOrThrow() ?: error("Encrypted host credential disappeared during enumeration.")
            }
            .toList()
    }

    override fun remove(hostId: String): Result<Unit> = runCatching {
        requireHostId(hostId)
        check(preferences.edit().remove(storageKey(hostId)).commit()) {
            "The encrypted credential could not be removed."
        }
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun encode(value: StoredHostCredential): ByteArray = ByteArrayOutputStream().use { bytes ->
        DataOutputStream(bytes).use { output ->
            output.writeInt(PAYLOAD_VERSION)
            output.writeUTF(value.hostId)
            output.writeUTF(value.endpoint.name)
            output.writeUTF(value.endpoint.baseUrl)
            output.writeUTF(value.credential.bearerToken)
            writeNullable(output, value.credential.deviceId)
            writeNullable(output, value.credential.workspaceId)
            writeNullable(output, value.credential.certificatePin?.value)
            output.writeBoolean(value.credential.expiresAtMillis != null)
            value.credential.expiresAtMillis?.let(output::writeLong)
        }
        bytes.toByteArray()
    }

    private fun decode(payload: ByteArray): StoredHostCredential = DataInputStream(ByteArrayInputStream(payload)).use { input ->
        require(input.readInt() == PAYLOAD_VERSION) { "The credential payload version is not supported." }
        val hostId = input.readUTF()
        val endpointName = input.readUTF()
        val endpointUrl = input.readUTF()
        val bearer = input.readUTF()
        val deviceId = readNullable(input)
        val workspaceId = readNullable(input)
        val pin = readNullable(input)?.let { CertificatePin.parse(it).getOrThrow() }
        val expiresAt = if (input.readBoolean()) input.readLong() else null
        require(input.read() == -1) { "The credential payload has trailing data." }
        StoredHostCredential(
            hostId = hostId,
            endpoint = WorkspaceEndpoint.parse(endpointName, endpointUrl).getOrThrow(),
            credential = WorkspaceCredential.create(bearer, deviceId, workspaceId, pin, expiresAt).getOrThrow(),
        )
    }

    private fun readBounded(input: DataInputStream, maximum: Int): ByteArray {
        val length = input.readInt()
        require(length in 1..maximum) { "The encrypted credential has an invalid field length." }
        return ByteArray(length).also(input::readFully)
    }

    private fun writeNullable(output: DataOutputStream, value: String?) {
        output.writeBoolean(value != null)
        value?.let(output::writeUTF)
    }

    private fun readNullable(input: DataInputStream): String? = if (input.readBoolean()) input.readUTF() else null

    private fun storageKey(hostId: String): String = "host." + Base64.getUrlEncoder().withoutPadding()
        .encodeToString(hostId.toByteArray(Charsets.UTF_8))

    private fun requireHostId(hostId: String) {
        require(hostId.length in 1..128 && hostId.all { it.isLetterOrDigit() || it in "-_.:" }) {
            "The host identifier is invalid."
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val STORAGE_VERSION = 1
        const val PAYLOAD_VERSION = 2
        const val MAX_IV_BYTES = 64
        const val MAX_CIPHERTEXT_BYTES = 32 * 1024
    }
}
