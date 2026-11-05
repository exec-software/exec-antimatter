package co.antimatter.app.remote

import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.ActiveTurn
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.ConversationSummary
import co.antimatter.app.domain.InferenceModel
import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.domain.RemoteHost
import co.antimatter.app.domain.ToolActivity
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.domain.WorkspaceProject
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale
import kotlinx.coroutines.flow.Flow

const val REMOTE_PROTOCOL_VERSION: Int = 1

/** Android's product-level boundary to a paired Antimatter host. */
interface RemoteWorkspaceGateway {
    suspend fun pair(offer: PairingOffer, request: PairingRequest): Result<PairingResult>
    suspend fun connect(endpoint: WorkspaceEndpoint, credential: WorkspaceCredential): Result<RemoteHost>
    suspend fun disconnect(hostId: String): Result<Unit>
    suspend fun snapshot(hostId: String, selectedThreadId: String? = null): Result<WorkspaceSnapshot>
    suspend fun thread(hostId: String, projectId: String, threadId: String): Result<ThreadSnapshot>

    /** Retrying the same command ID must return the original receipt without repeating effects. */
    suspend fun send(command: WorkspaceCommand): Result<CommandReceipt>

    /** Ordered long-poll frames. A reset requires an authoritative [snapshot]. */
    fun events(hostId: String, after: EventCursor?): Flow<WorkspaceStreamFrame>

    suspend fun createAttachment(
        hostId: String,
        projectId: String,
        request: AttachmentUploadRequest,
    ): Result<AttachmentUpload>

    suspend fun uploadAttachment(
        hostId: String,
        upload: AttachmentUpload,
        content: ByteArray,
    ): Result<RemoteAsset>

    suspend fun fetchAsset(hostId: String, assetId: String): Result<AssetPayload>
}

data class PairingRequest(
    val deviceName: String,
    val clientVersion: String,
    val requestedCapabilities: Set<WorkspaceCapability>,
    val protocolMinor: Int = 0,
)

data class PairingResult(
    val host: RemoteHost,
    /** One remote service identity hosted by [host]; required on every command envelope. */
    val workspaceId: String,
    val projects: List<WorkspaceProject>,
    val credential: WorkspaceCredential,
    val grantedCapabilities: Set<WorkspaceCapability>,
    val protocolVersion: Int,
    val hostVersion: String?,
)

data class CommandReceipt(
    val commandId: String,
    val requestId: String?,
    val disposition: CommandDisposition,
    val threadId: String? = null,
    val clientThreadId: String? = null,
    val revision: String? = null,
)

/** Lightweight bootstrap. Full transcript bodies are loaded through [ThreadSnapshot]. */
data class WorkspaceSnapshot(
    val host: RemoteHost,
    val workspaceId: String,
    val protocolVersion: Int,
    val hostVersion: String?,
    val revision: String,
    val projects: List<WorkspaceProject>,
    val models: List<InferenceModel>,
    val conversations: List<ConversationSummary>,
    val selectedThread: ThreadSnapshot?,
    val activeTurns: List<ActiveTurn>,
    val cursor: EventCursor,
)

data class ThreadSnapshot(
    val hostId: String,
    val projectId: String,
    val conversation: Conversation,
    val revision: String,
    /** Event position captured with this transcript, when the host supports it. */
    val cursor: EventCursor? = null,
)

enum class CommandDisposition {
    ACCEPTED,
    ALREADY_ACCEPTED,
    ALREADY_FINISHED,
}

data class EventCursor(
    /** Opaque host boot/session epoch. Sequence numbers are meaningful only inside this epoch. */
    val epoch: String,
    val sequence: Long,
)

enum class CursorDisposition {
    APPLY,
    DUPLICATE,
    RESYNC,
}

/** Pure reducer used before applying a frame and cursor in one durable transaction. */
fun classifyCursor(current: EventCursor?, incoming: EventCursor): CursorDisposition = when {
    current == null -> CursorDisposition.APPLY
    current.epoch != incoming.epoch -> CursorDisposition.RESYNC
    incoming.sequence <= current.sequence -> CursorDisposition.DUPLICATE
    current.sequence == Long.MAX_VALUE -> CursorDisposition.RESYNC
    incoming.sequence == current.sequence + 1L -> CursorDisposition.APPLY
    else -> CursorDisposition.RESYNC
}

/**
 * Network snapshots can finish out of order with long-poll events. A response from the same epoch
 * may only replace state through its own cursor, while an epoch-changing response is accepted only
 * when no event advanced after the request began. Older hosts omit a thread cursor, in which case
 * the response is safe only if the local cursor stayed exactly where the request started.
 */
fun shouldApplyNetworkSnapshot(
    current: EventCursor?,
    requestedAt: EventCursor?,
    incoming: EventCursor?,
): Boolean = when {
    current == null -> true
    incoming == null -> current == requestedAt
    incoming.epoch == current.epoch -> incoming.sequence >= current.sequence
    else -> current == requestedAt
}

data class WorkspaceEventEnvelope(
    val protocolVersion: Int,
    val hostId: String,
    val projectId: String?,
    val threadId: String?,
    val cursor: EventCursor,
    /** Preserved even when this client does not understand [event]. */
    val kind: String,
    val event: WorkspaceEvent,
)

sealed interface WorkspaceStreamFrame {
    data class Event(val envelope: WorkspaceEventEnvelope) : WorkspaceStreamFrame

    data class Reset(
        val hostId: String,
        val reason: StreamResetReason,
        val snapshotRevision: String?,
        val cursor: EventCursor?,
    ) : WorkspaceStreamFrame
}

enum class StreamResetReason {
    MISSING_CURSOR,
    CURSOR_EXPIRED,
    EPOCH_CHANGED,
    CURSOR_AHEAD,
    GAP,
    PROTOCOL_CHANGED,
}

class WorkspaceEndpoint private constructor(
    val name: String,
    val baseUrl: String,
) {
    override fun toString(): String = "WorkspaceEndpoint(name=$name, baseUrl=$baseUrl)"

    companion object {
        fun parse(name: String, rawUrl: String): Result<WorkspaceEndpoint> = runCatching {
            val cleanName = name.trim()
            require(cleanName.isNotEmpty()) { "Give this host a name." }
            require(cleanName.length <= 80) { "Host names must be 80 characters or fewer." }
            val cleanUrl = rawUrl.trim()
            require(cleanUrl.length <= 2_048) { "The host URL is too long." }
            val uri = URI(cleanUrl)
            require(uri.scheme.equals("https", ignoreCase = true)) { "Remote hosts require HTTPS." }
            val host = requireNotNull(uri.host?.takeIf(String::isNotBlank)) { "Enter a complete host URL." }
            require(uri.userInfo == null) { "Credentials must not be embedded in the URL." }
            require(uri.fragment == null && uri.query == null) { "Use the host base URL without a query or fragment." }
            require(uri.port == -1 || uri.port in 1..65_535) { "Enter a valid HTTPS port." }

            val rawPath = uri.rawPath.orEmpty()
            require('\\' !in rawPath) { "Host paths cannot contain backslashes." }
            require(!rawPath.contains("%2f", ignoreCase = true)) { "Encoded path separators are not allowed." }
            require(!rawPath.contains("%5c", ignoreCase = true)) { "Encoded path separators are not allowed." }
            require(!rawPath.contains("%2e", ignoreCase = true)) { "Encoded dot segments are not allowed." }
            require(rawPath.split('/').none { it == "." || it == ".." }) { "Host paths cannot contain dot segments." }

            val normalizedPath = rawPath.trimEnd('/').ifEmpty { null }
            val normalizedHost = host.removePrefix("[").removeSuffix("]").lowercase(Locale.ROOT).let {
                if (':' in it) "[$it]" else it
            }
            val normalized = buildString {
                append("https://")
                append(normalizedHost)
                if (uri.port != -1) append(':').append(uri.port)
                if (normalizedPath != null) append(normalizedPath)
            }
            WorkspaceEndpoint(cleanName, normalized)
        }
    }
}

/** SHA-256 of the leaf certificate DER bytes, rendered using standard pin notation. */
class CertificatePin private constructor(
    internal val digest: ByteArray,
) {
    val value: String = "sha256/${Base64.getEncoder().encodeToString(digest)}"

    fun matches(certificateDer: ByteArray): Boolean = MessageDigest.isEqual(
        digest,
        MessageDigest.getInstance("SHA-256").digest(certificateDer),
    )

    override fun equals(other: Any?): Boolean = other is CertificatePin && MessageDigest.isEqual(digest, other.digest)
    override fun hashCode(): Int = digest.contentHashCode()
    override fun toString(): String = value

    companion object {
        fun parse(raw: String): Result<CertificatePin> = runCatching {
            require(raw.startsWith("sha256/")) { "The certificate pin must start with sha256/." }
            val decoded = Base64.getDecoder().decode(raw.removePrefix("sha256/"))
            require(decoded.size == 32) { "The certificate pin must contain one SHA-256 digest." }
            CertificatePin(decoded.copyOf())
        }
    }
}

/**
 * Short-lived scan-or-paste pairing code. It is deliberately not a URL/custom scheme, so only
 * Antimatter's in-app scanner or explicit paste path can redeem its one-time secret.
 * Supported form:
 * ANTIMATTER-PAIRING-V1?endpoint=...&host=...&offer=...&secret=...&pin=...&expires=...
 */
class PairingOffer private constructor(
    val endpoint: WorkspaceEndpoint,
    val hostId: String,
    val offerId: String,
    internal val oneTimeSecret: String,
    val certificatePin: CertificatePin,
    val expiresAtMillis: Long,
) {
    fun isExpired(nowMillis: Long = System.currentTimeMillis()): Boolean = nowMillis >= expiresAtMillis
    override fun toString(): String = "PairingOffer(hostId=$hostId, offerId=<redacted>, endpoint=${endpoint.baseUrl})"

    companion object {
        private const val PREFIX = "ANTIMATTER-PAIRING-V1?"
        private val requiredKeys = setOf("endpoint", "host", "offer", "secret", "pin", "expires")

        fun parse(raw: String, nowMillis: Long = System.currentTimeMillis()): Result<PairingOffer> = runCatching {
            require(raw.length <= 8_192) { "The pairing code is too long." }
            val code = raw.trim()
            require(code.startsWith(PREFIX)) { "This is not an Antimatter pairing code." }
            val params = parseStrictQuery(code.removePrefix(PREFIX))
            require(params.keys == requiredKeys) { "This pairing code has missing or unknown fields." }

            val hostId = requireIdentifier("host", params.getValue("host"))
            val offerId = requireIdentifier("offer", params.getValue("offer"))
            val secret = params.getValue("secret")
            require(secret.length == 43 && secret.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
                "The pairing secret is invalid."
            }
            val expiresAt = params.getValue("expires").toLong()
            require(expiresAt > nowMillis) { "This pairing code has expired." }
            require(expiresAt <= nowMillis + 30L * 60L * 1_000L) { "This pairing code expires too far in the future." }

            PairingOffer(
                endpoint = WorkspaceEndpoint.parse(hostId, params.getValue("endpoint")).getOrThrow(),
                hostId = hostId,
                offerId = offerId,
                oneTimeSecret = secret,
                certificatePin = CertificatePin.parse(params.getValue("pin")).getOrThrow(),
                expiresAtMillis = expiresAt,
            )
        }

        private fun parseStrictQuery(rawQuery: String?): Map<String, String> {
            require(!rawQuery.isNullOrBlank()) { "The pairing code has no fields." }
            val result = linkedMapOf<String, String>()
            rawQuery.split('&').forEach { component ->
                require(component.isNotEmpty() && '=' in component) { "The pairing code contains an invalid field." }
                val (rawKey, rawValue) = component.split('=', limit = 2)
                val key = decodeQuery(rawKey)
                val value = decodeQuery(rawValue)
                require(key !in result) { "The pairing code contains duplicate fields." }
                result[key] = value
            }
            return result
        }

        private fun decodeQuery(value: String): String = URLDecoder.decode(value, StandardCharsets.UTF_8.name())

        private fun requireIdentifier(label: String, value: String): String {
            require(value.length in 1..128) { "The pairing $label is invalid." }
            require(value.all { it.isLetterOrDigit() || it in "-_.:" }) { "The pairing $label is invalid." }
            return value
        }
    }
}

/** Long-lived device bearer. It must only be persisted by a Keystore-backed credential store. */
class WorkspaceCredential private constructor(
    internal val bearerToken: String,
    val deviceId: String?,
    val workspaceId: String?,
    val certificatePin: CertificatePin?,
    val expiresAtMillis: Long?,
) {
    override fun toString(): String = "WorkspaceCredential(<redacted>)"

    companion object {
        fun create(
            bearerToken: String,
            deviceId: String? = null,
            workspaceId: String? = null,
            certificatePin: CertificatePin? = null,
            expiresAtMillis: Long? = null,
        ): Result<WorkspaceCredential> = runCatching {
            val token = bearerToken.trim()
            require(token.length in 24..4_096) { "The device credential has an invalid length." }
            require(token.none(Char::isWhitespace)) { "The device credential cannot contain whitespace." }
            require(deviceId == null || deviceId.length in 1..128) { "The device identifier is invalid." }
            require(workspaceId == null || workspaceId.length in 1..128) { "The workspace identifier is invalid." }
            WorkspaceCredential(token, deviceId, workspaceId, certificatePin, expiresAtMillis)
        }
    }
}

sealed interface WorkspaceCommand {
    val hostId: String
    val projectId: String
    val commandId: String

    data class CreateThread(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        /** Stable client key used only to reconcile a lost create acknowledgement. */
        val clientThreadId: String,
        val title: String? = null,
        val model: ModelKey? = null,
        val accessMode: AccessMode = AccessMode.ASK,
    ) : WorkspaceCommand

    data class RenameThread(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val expectedRevision: String,
        val title: String,
    ) : WorkspaceCommand

    data class SetThreadPinned(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val expectedRevision: String,
        val pinned: Boolean,
    ) : WorkspaceCommand

    data class SetThreadModel(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val expectedRevision: String,
        val model: ModelKey,
    ) : WorkspaceCommand

    data class DeleteThread(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val expectedRevision: String,
    ) : WorkspaceCommand

    data class StartTurn(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val requestId: String,
        val userMessageId: String,
        val responseMessageId: String,
        val expectedRevision: String,
        val model: ModelKey,
        val content: String,
        val attachmentIds: List<String>,
        /** A request only; the host's access ceiling always wins. */
        val accessMode: AccessMode,
    ) : WorkspaceCommand

    data class CancelTurn(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val requestId: String,
    ) : WorkspaceCommand

    data class SteerTurn(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val requestId: String,
        val note: String,
        val now: Boolean = true,
    ) : WorkspaceCommand

    data class ResolveApproval(
        override val hostId: String,
        override val projectId: String,
        override val commandId: String,
        val threadId: String,
        val requestId: String,
        val approvalId: String,
        val decision: ApprovalDecision,
    ) : WorkspaceCommand
}

enum class ApprovalDecision {
    ALLOW_ONCE,
    DECLINE,
}

sealed interface WorkspaceEvent {
    data class TextDelta(
        val requestId: String,
        val responseMessageId: String,
        val content: String,
    ) : WorkspaceEvent

    data class Liveness(val requestId: String, val waiting: Boolean) : WorkspaceEvent
    data class ToolChanged(val activity: ToolActivity) : WorkspaceEvent
    data class ApprovalRequested(val activity: ToolActivity) : WorkspaceEvent

    data class ApprovalResolved(
        val requestId: String,
        val approvalId: String,
        val resolution: ApprovalResolution,
    ) : WorkspaceEvent

    data class SteerAcknowledged(
        val requestId: String,
        val commandId: String,
    ) : WorkspaceEvent

    data class ContextUpdated(
        val requestId: String,
        val inputTokens: Long?,
        val outputTokens: Long?,
        val contextTokens: Long?,
        val contextLimit: Long?,
        val inference: co.antimatter.app.domain.TurnInference? = null,
    ) : WorkspaceEvent

    data class PreviewReady(
        val requestId: String,
        val responseMessageId: String?,
        val activityId: String?,
        val preview: PreviewRef,
    ) : WorkspaceEvent

    data class ThreadChanged(val summary: ConversationSummary) : WorkspaceEvent
    data object ThreadDeleted : WorkspaceEvent
    data class CatalogChanged(val revision: String) : WorkspaceEvent

    /** A command was durably accepted but its host-side dispatch could not be completed. */
    data class CommandFailed(
        val commandId: String,
        val requestId: String?,
        val code: String,
        val userMessage: String,
        val retryable: Boolean,
    ) : WorkspaceEvent

    data class TurnFinished(
        val requestId: String,
        val responseMessageId: String,
        val finishReason: String?,
    ) : WorkspaceEvent

    data class TurnFailed(
        val requestId: String,
        val responseMessageId: String?,
        val code: TurnFailureCode,
        val userMessage: String,
        val retryable: Boolean,
    ) : WorkspaceEvent

    /** Unknown kinds are retained so their cursor can be committed safely. */
    data class Unknown(val rawPayload: String?) : WorkspaceEvent
}

enum class ApprovalResolution {
    APPROVED,
    DECLINED,
    EXPIRED,
    CANCELLED,
}

enum class TurnFailureCode {
    UNAVAILABLE,
    AUTHORIZATION,
    INVALID_REQUEST,
    MODEL_UNAVAILABLE,
    CONTEXT_LIMIT,
    PROVIDER_FAILURE,
    INTERNAL,
}

enum class RemoteFailureCode {
    NETWORK,
    TLS_PIN_MISMATCH,
    AUTHENTICATION,
    AUTHORIZATION,
    INVALID_REQUEST,
    NOT_FOUND,
    CONFLICT,
    CURSOR_EXPIRED,
    RATE_LIMITED,
    INCOMPATIBLE_PROTOCOL,
    PAYLOAD_TOO_LARGE,
    HOST_UNAVAILABLE,
    MALFORMED_RESPONSE,
    INTERNAL,
}

class RemoteWorkspaceException(
    val code: RemoteFailureCode,
    override val message: String,
    val retryable: Boolean,
    val httpStatus: Int? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

data class AttachmentUploadRequest(
    val name: String,
    val size: Long,
    val mediaType: String,
    val sha256Base64: String,
)

data class AttachmentUpload(
    val hostId: String,
    val projectId: String,
    val uploadId: String,
    val maxBytes: Long,
    val expiresAtMillis: Long,
)

data class RemoteAsset(
    val hostId: String,
    val assetId: String,
    val mediaType: String,
    val size: Long,
    val sha256Base64: String,
    val expiresAtMillis: Long?,
)

data class AssetPayload(
    val asset: RemoteAsset,
    val bytes: ByteArray,
) {
    override fun equals(other: Any?): Boolean = other is AssetPayload && asset == other.asset && bytes.contentEquals(other.bytes)
    override fun hashCode(): Int = 31 * asset.hashCode() + bytes.contentHashCode()
}
