package co.antimatter.app.remote

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Dependency-free active-app transport. HTTPS identity is the exact certificate from the trusted
 * scanned-or-pasted pairing offer, so the host's intentionally self-signed certificate never enters the system trust
 * store. Long-poll keeps the active app current; durable cursors are owned by the repository.
 */
class HttpsRemoteWorkspaceGateway(
    private val credentialStore: WorkspaceCredentialStore,
    private val connectTimeoutMillis: Int = 15_000,
    private val requestTimeoutMillis: Int = 35_000,
    private val eventWaitMillis: Int = 25_000,
) : RemoteWorkspaceGateway {
    private class Session(
        val hostId: String,
        val endpoint: WorkspaceEndpoint,
        val credential: WorkspaceCredential,
        val workspaceId: String,
    )

    private val sessionLock = Any()
    private val connectionAttempts = mutableMapOf<String, Long>()
    private val sessions = ConcurrentHashMap<String, Session>()
    private val socketFactories = ConcurrentHashMap<String, SSLSocketFactory>()

    override suspend fun pair(offer: PairingOffer, request: PairingRequest): Result<PairingResult> = remoteResult {
        if (offer.isExpired()) {
            throw RemoteWorkspaceException(
                RemoteFailureCode.AUTHENTICATION,
                "This pairing code expired. Generate a new QR code on the computer.",
                false,
            )
        }
        val attempt = beginConnection(offer.endpoint)
        val body = RemoteJsonCodec.pairingRequest(offer, request)
        val response = request(
            endpoint = offer.endpoint,
            connectionAttempt = attempt,
            pin = offer.certificatePin,
            authorization = "Pair ${offer.oneTimeSecret}",
            method = "POST",
            path = "/v1/pair",
            body = body.toByteArray(StandardCharsets.UTF_8),
            contentType = JSON_CONTENT_TYPE,
            maximumResponseBytes = MAX_JSON_BYTES,
        )
        val result = RemoteJsonCodec.pairingResult(response.body.toString(StandardCharsets.UTF_8), offer)
        currentCoroutineContext().ensureActive()
        val endpoint = namedEndpoint(result.host.name, offer.endpoint)
        val stored = StoredHostCredential(result.host.id, endpoint, result.credential)
        val context = currentCoroutineContext()
        synchronized(sessionLock) {
            requireConnectionAttempt(offer.endpoint, attempt)
            context.ensureActive()
            credentialStore.save(stored).getOrElse { error ->
                if (error is CancellationException) throw error
                // The one-time offer has already been consumed; retrying it cannot repair storage.
                throw RemoteWorkspaceException(
                    RemoteFailureCode.INTERNAL,
                    "The computer accepted pairing, but this phone could not save its connection. " +
                        "Check available storage, then remove this device on the computer and generate a new QR code.",
                    false,
                    cause = error,
                )
            }
            context.ensureActive()
            sessions[result.host.id] = Session(result.host.id, endpoint, result.credential, result.workspaceId)
        }
        result
    }

    override suspend fun connect(
        endpoint: WorkspaceEndpoint,
        credential: WorkspaceCredential,
    ): Result<co.antimatter.app.domain.RemoteHost> = remoteResult {
        val pin = credential.certificatePin ?: throw RemoteWorkspaceException(
            RemoteFailureCode.AUTHENTICATION, "This host must be paired again before connecting.", false,
        )
        if (credential.expiresAtMillis?.let { it <= System.currentTimeMillis() } == true) {
            throw RemoteWorkspaceException(
                RemoteFailureCode.AUTHENTICATION, "The device credential has expired. Pair this computer again.", false,
            )
        }
        val attempt = beginConnection(endpoint)
        val response = request(
            endpoint = endpoint,
            connectionAttempt = attempt,
            pin = pin,
            authorization = "Bearer ${credential.bearerToken}",
            method = "GET",
            path = "/v1/bootstrap",
            maximumResponseBytes = MAX_JSON_BYTES,
        )
        val snapshot = RemoteJsonCodec.snapshot(response.body.toString(StandardCharsets.UTF_8), endpoint)
        credential.workspaceId?.let { require(it == snapshot.workspaceId) { "The connected workspace changed identity." } }
        currentCoroutineContext().ensureActive()
        val namedEndpoint = namedEndpoint(snapshot.host.name, endpoint)
        val context = currentCoroutineContext()
        synchronized(sessionLock) {
            requireConnectionAttempt(endpoint, attempt)
            context.ensureActive()
            if (namedEndpoint.name != endpoint.name) {
                // Cosmetic metadata storage must not turn a healthy connection into a failure.
                credentialStore.save(StoredHostCredential(snapshot.host.id, namedEndpoint, credential)).onFailure {
                    if (it is CancellationException) throw it
                }
            }
            context.ensureActive()
            sessions[snapshot.host.id] = Session(snapshot.host.id, namedEndpoint, credential, snapshot.workspaceId)
        }
        snapshot.host
    }

    override suspend fun disconnect(hostId: String): Result<Unit> = remoteResult {
        // Forget locally even when the computer is offline. Revoking the host credential remains
        // best effort, but an unreachable listener cannot keep an in-memory session usable.
        val session = synchronized(sessionLock) {
            val removed = sessions.remove(hostId)
            // A process-restart bootstrap can be in flight before there is an active session.
            val endpoint = removed?.endpoint ?: credentialStore.load(hostId).getOrNull()?.endpoint
            endpoint?.let { beginConnection(it) }
            credentialStore.remove(hostId).getOrThrow()
            removed
        }
        if (session != null) {
            request(
                endpoint = session.endpoint,
                pin = requirePin(session),
                authorization = bearer(session),
                method = "DELETE",
                path = "/v1/session",
                maximumResponseBytes = MAX_ERROR_BYTES,
            )
        }
    }

    override suspend fun snapshot(hostId: String, selectedThreadId: String?): Result<WorkspaceSnapshot> = remoteResult {
        val session = requireSession(hostId)
        val query = selectedThreadId?.let { "?threadId=${queryComponent(it)}" }.orEmpty()
        val response = request(
            session = session,
            method = "GET",
            path = "/v1/bootstrap$query",
            maximumResponseBytes = MAX_JSON_BYTES,
        )
        RemoteJsonCodec.snapshot(response.body.toString(StandardCharsets.UTF_8), session.endpoint).also {
            require(it.host.id == hostId) { "The connected host changed identity." }
        }
    }

    override suspend fun thread(hostId: String, projectId: String, threadId: String): Result<ThreadSnapshot> = remoteResult {
        requireIdentifier(projectId, "project")
        requireIdentifier(threadId, "thread")
        val session = requireSession(hostId)
        val response = request(
            session = session,
            method = "GET",
            path = "/v1/threads/${pathSegment(threadId)}",
            maximumResponseBytes = MAX_JSON_BYTES,
        )
        RemoteJsonCodec.threadSnapshot(response.body.toString(StandardCharsets.UTF_8), hostId).also {
            require(it.projectId == projectId) { "The thread belongs to a different project." }
        }
    }

    override suspend fun send(command: WorkspaceCommand): Result<CommandReceipt> = remoteResult {
        val session = requireSession(command.hostId)
        val response = request(
            session = session,
            method = "POST",
            path = "/v1/commands",
            body = RemoteJsonCodec.command(command, session.workspaceId).toByteArray(StandardCharsets.UTF_8),
            contentType = JSON_CONTENT_TYPE,
            maximumResponseBytes = MAX_ERROR_BYTES,
        )
        RemoteJsonCodec.commandReceipt(response.body.toString(StandardCharsets.UTF_8)).also {
            require(it.commandId == command.commandId) { "The command receipt has the wrong identity." }
        }
    }

    override fun events(hostId: String, after: EventCursor?): Flow<WorkspaceStreamFrame> = flow {
        var cursor = after
        if (cursor == null) {
            emit(WorkspaceStreamFrame.Reset(hostId, StreamResetReason.MISSING_CURSOR, null, null))
            return@flow
        }
        val session = requireSession(hostId)
        while (currentCoroutineContext().isActive) {
            currentCoroutineContext().ensureActive()
            val frames = withContext(Dispatchers.IO) {
                try {
                    val parameters = buildList {
                        cursor?.let {
                            add("epoch=${queryComponent(it.epoch)}")
                            add("after=${it.sequence}")
                        }
                        add("waitMs=$eventWaitMillis")
                    }.joinToString("&")
                    val response = request(
                        session = session,
                        method = "GET",
                        path = "/v1/events?$parameters",
                        readTimeoutMillis = eventWaitMillis + 10_000,
                        maximumResponseBytes = MAX_EVENTS_BYTES,
                    )
                    RemoteJsonCodec.streamFrames(response.body.toString(StandardCharsets.UTF_8), hostId, session.workspaceId)
                } catch (error: Throwable) {
                    currentCoroutineContext().ensureActive()
                    throw mapFailure(error)
                }
            }
            for (frame in frames) {
                requireCurrentSession(session)
                emit(frame)
                when (frame) {
                    is WorkspaceStreamFrame.Event -> cursor = frame.envelope.cursor
                    is WorkspaceStreamFrame.Reset -> return@flow
                }
            }
        }
    }

    override suspend fun createAttachment(
        hostId: String,
        projectId: String,
        request: AttachmentUploadRequest,
    ): Result<AttachmentUpload> = remoteResult {
        require(request.size in 0..MAX_ASSET_BYTES.toLong()) { "The attachment is too large." }
        require(request.name.isNotBlank() && request.name.length <= 240) { "The attachment name is invalid." }
        require(request.mediaType.isNotBlank() && request.mediaType.length <= 200) { "The attachment media type is invalid." }
        val session = requireSession(hostId)
        val response = request(
            session = session,
            method = "POST",
            path = "/v1/uploads",
            body = RemoteJsonCodec.attachmentRequest(projectId, request).toByteArray(StandardCharsets.UTF_8),
            contentType = JSON_CONTENT_TYPE,
            maximumResponseBytes = MAX_ERROR_BYTES,
        )
        RemoteJsonCodec.attachmentUpload(response.body.toString(StandardCharsets.UTF_8), hostId, projectId)
    }

    override suspend fun uploadAttachment(
        hostId: String,
        upload: AttachmentUpload,
        content: ByteArray,
    ): Result<RemoteAsset> = remoteResult {
        require(upload.hostId == hostId) { "The upload belongs to a different host." }
        require(content.size.toLong() <= upload.maxBytes && content.size <= MAX_ASSET_BYTES) { "The attachment is too large." }
        require(upload.expiresAtMillis > System.currentTimeMillis()) { "The attachment upload has expired." }
        val session = requireSession(hostId)
        request(
            session = session,
            method = "PUT",
            path = "/v1/uploads/${pathSegment(upload.uploadId)}",
            body = content,
            contentType = "application/octet-stream",
            maximumResponseBytes = MAX_ERROR_BYTES,
        )
        val completed = request(
            session = session,
            method = "POST",
            path = "/v1/uploads/${pathSegment(upload.uploadId)}/complete",
            body = ByteArray(0),
            contentType = JSON_CONTENT_TYPE,
            maximumResponseBytes = MAX_ERROR_BYTES,
        )
        RemoteJsonCodec.remoteAsset(completed.body.toString(StandardCharsets.UTF_8), hostId)
    }

    override suspend fun fetchAsset(hostId: String, assetId: String): Result<AssetPayload> = remoteResult {
        requireIdentifier(assetId, "asset")
        val session = requireSession(hostId)
        val response = request(
            session = session,
            method = "GET",
            path = "/v1/assets/${pathSegment(assetId)}",
            maximumResponseBytes = MAX_ASSET_BYTES,
        )
        val mediaType = response.headers["Content-Type"]?.substringBefore(';') ?: "application/octet-stream"
        val sha256 = response.headers["X-Antimatter-Sha256"].orEmpty()
        val expires = response.headers["X-Antimatter-Expires"]?.toLongOrNull()
        AssetPayload(
            asset = RemoteAsset(hostId, assetId, mediaType, response.body.size.toLong(), sha256, expires),
            bytes = response.body,
        )
    }

    private suspend fun <T> remoteResult(block: suspend () -> T): Result<T> = withContext(Dispatchers.IO) {
        try {
            Result.success(block())
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            currentCoroutineContext().ensureActive()
            Result.failure(mapFailure(error))
        }
    }

    private fun beginConnection(endpoint: WorkspaceEndpoint): Long = synchronized(sessionLock) {
        (connectionAttempts[endpoint.baseUrl].orZero() + 1L).also {
            connectionAttempts[endpoint.baseUrl] = it
        }
    }

    private fun Long?.orZero(): Long = this ?: 0L

    private fun requireConnectionAttempt(endpoint: WorkspaceEndpoint, attempt: Long) {
        if (connectionAttempts[endpoint.baseUrl] != attempt) {
            throw CancellationException("This connection attempt was superseded.")
        }
    }

    private fun requireCurrentSession(session: Session) {
        if (sessions[session.hostId] !== session) {
            throw CancellationException("This remote session was replaced or forgotten.")
        }
    }

    /** A response belongs to the session that issued it, including failures and empty polls. */
    private suspend fun request(
        session: Session,
        method: String,
        path: String,
        body: ByteArray? = null,
        contentType: String? = null,
        readTimeoutMillis: Int = requestTimeoutMillis,
        maximumResponseBytes: Int,
    ): HttpResponse {
        requireCurrentSession(session)
        try {
            return request(
                endpoint = session.endpoint,
                pin = requirePin(session),
                authorization = bearer(session),
                method = method,
                path = path,
                body = body,
                contentType = contentType,
                readTimeoutMillis = readTimeoutMillis,
                maximumResponseBytes = maximumResponseBytes,
            )
        } finally {
            // Suppress even a late network/authentication error from an obsolete connection.
            // It cannot describe the replacement session's health.
            requireCurrentSession(session)
        }
    }

    private fun requireSession(hostId: String): Session = sessions[hostId]
        ?: throw RemoteWorkspaceException(RemoteFailureCode.AUTHENTICATION, "Pair this device with the host again.", false)

    private fun requirePin(session: Session): CertificatePin = session.credential.certificatePin
        ?: throw RemoteWorkspaceException(RemoteFailureCode.AUTHENTICATION, "Pair this device with the host again.", false)

    private fun bearer(session: Session): String = "Bearer ${session.credential.bearerToken}"

    private data class HttpResponse(
        val status: Int,
        val headers: Map<String, String>,
        val body: ByteArray,
    )

    private suspend fun request(
        endpoint: WorkspaceEndpoint,
        pin: CertificatePin,
        authorization: String,
        connectionAttempt: Long? = null,
        method: String,
        path: String,
        body: ByteArray? = null,
        contentType: String? = null,
        readTimeoutMillis: Int = requestTimeoutMillis,
        maximumResponseBytes: Int,
    ): HttpResponse {
        require(path.startsWith('/')) { "Remote paths must be absolute." }
        val connection = (java.net.URL(endpoint.baseUrl.trimEnd('/') + path).openConnection() as HttpsURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMillis
            this.readTimeout = readTimeoutMillis
            useCaches = false
            instanceFollowRedirects = false
            doInput = true
            sslSocketFactory = socketFactories.computeIfAbsent(pin.value) { pinnedSocketFactory(pin) }
            hostnameVerifier = pinnedHostnameVerifier(pin)
            setRequestProperty("Accept", JSON_CONTENT_TYPE)
            setRequestProperty("Authorization", authorization)
            setRequestProperty("X-Antimatter-Protocol", REMOTE_PROTOCOL_VERSION.toString())
            if (body != null) {
                doOutput = true
                setFixedLengthStreamingMode(body.size)
                setRequestProperty("Content-Type", contentType ?: "application/octet-stream")
            }
        }
        // Await the blocking socket in a child so cancelling a reconnect/foreground refresh
        // closes the actual connection immediately, rather than waiting for its read timeout.
        return try {
            coroutineScope {
                currentCoroutineContext().ensureActive()
                val response = async(Dispatchers.IO) {
                    body?.let { payload -> connection.outputStream.use { it.write(payload) } }
                    val status = connection.responseCode
                    val limit = if (status in 200..299) maximumResponseBytes else MAX_ERROR_BYTES
                    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                    val responseBody = stream?.use { readBounded(it, limit) } ?: ByteArray(0)
                    if (status !in 200..299) throw httpFailure(status, responseBody, pairing = path == "/v1/pair")
                    val headers = buildMap {
                        for ((name, values) in connection.headerFields) {
                            if (name != null && !values.isNullOrEmpty()) put(name, values.first())
                        }
                    }
                    HttpResponse(status, headers, responseBody)
                }
                try {
                    response.await()
                } finally {
                    connection.disconnect()
                }
            }
        } finally {
            if (connectionAttempt != null) synchronized(sessionLock) {
                requireConnectionAttempt(endpoint, connectionAttempt)
            }
        }
    }

    private fun readBounded(stream: InputStream, maximum: Int): ByteArray {
        val output = ByteArrayOutputStream(minOf(maximum, 32 * 1024))
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            total += read
            if (total > maximum) {
                throw RemoteWorkspaceException(RemoteFailureCode.PAYLOAD_TOO_LARGE, "The host response is too large.", false)
            }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private fun httpFailure(status: Int, body: ByteArray, pairing: Boolean): RemoteWorkspaceException {
        if (pairing && (status == 401 || status == 410)) {
            return RemoteWorkspaceException(
                RemoteFailureCode.AUTHENTICATION,
                "This pairing code expired or was already used. Generate a new QR code on the computer.",
                false,
                status,
            )
        }
        val parsedRoot = runCatching { JSONObject(body.toString(StandardCharsets.UTF_8)) }.getOrNull()
        val parsed = parsedRoot?.optJSONObject("error") ?: parsedRoot
        val wireCode = parsed?.optString("code").orEmpty()
        val code = when (wireCode) {
            "AUTHENTICATION", "PAIRING_OFFER_INVALID" -> RemoteFailureCode.AUTHENTICATION
            "AUTHORIZATION" -> RemoteFailureCode.AUTHORIZATION
            "NOT_FOUND" -> RemoteFailureCode.NOT_FOUND
            "CONFLICT", "IDEMPOTENCY_CONFLICT" -> RemoteFailureCode.CONFLICT
            "CURSOR_EXPIRED" -> RemoteFailureCode.CURSOR_EXPIRED
            "RATE_LIMITED", "PAIRING_BUSY" -> RemoteFailureCode.RATE_LIMITED
            "INCOMPATIBLE_PROTOCOL", "UNKNOWN_COMMAND" -> RemoteFailureCode.INCOMPATIBLE_PROTOCOL
            "LIMIT_EXCEEDED" -> RemoteFailureCode.PAYLOAD_TOO_LARGE
            "INVALID_REQUEST" -> RemoteFailureCode.INVALID_REQUEST
            else -> when (status) {
                401 -> RemoteFailureCode.AUTHENTICATION
                403 -> RemoteFailureCode.AUTHORIZATION
                404 -> RemoteFailureCode.NOT_FOUND
                409 -> RemoteFailureCode.CONFLICT
                413 -> RemoteFailureCode.PAYLOAD_TOO_LARGE
                426 -> RemoteFailureCode.INCOMPATIBLE_PROTOCOL
                429 -> RemoteFailureCode.RATE_LIMITED
                in 500..599 -> RemoteFailureCode.HOST_UNAVAILABLE
                else -> RemoteFailureCode.INVALID_REQUEST
            }
        }
        val safeMessage = parsed?.optString("message")?.takeIf { it.isNotBlank() && it.length <= 500 }
            ?: when (code) {
                RemoteFailureCode.AUTHENTICATION -> "The host rejected this device credential."
                RemoteFailureCode.AUTHORIZATION -> "This device is not allowed to perform that action."
                RemoteFailureCode.NOT_FOUND -> "The requested remote item no longer exists."
                RemoteFailureCode.CONFLICT -> "Remote state changed. Refresh and try again."
                RemoteFailureCode.PAYLOAD_TOO_LARGE -> "The remote request or response is too large."
                RemoteFailureCode.RATE_LIMITED -> "The host is busy. Try again shortly."
                RemoteFailureCode.INCOMPATIBLE_PROTOCOL -> "Update Antimatter on this device and host."
                else -> "The remote host rejected the request."
            }
        val retryable = parsed?.optBoolean("retryable", status == 429 || status in 500..599)
            ?: (status == 429 || status in 500..599)
        return RemoteWorkspaceException(code, safeMessage, retryable, status)
    }

    internal fun mapFailure(error: Throwable): Throwable {
        if (error is CancellationException) return error
        if (error is RemoteWorkspaceException) return error
        // TLS handshakes can fail when Wi-Fi drops or a sleeping connection is closed.
        // Only a certificate failure establishes a pin/identity problem requiring pairing.
        if (error.hasCause<CertificateException>()) {
            return RemoteWorkspaceException(
                RemoteFailureCode.TLS_PIN_MISMATCH,
                "The host certificate does not match the paired device. Pair again only if you intentionally reset the host.",
                false,
                cause = error,
            )
        }
        if (error is SocketTimeoutException) {
            return RemoteWorkspaceException(RemoteFailureCode.NETWORK,
                "The computer did not respond in time. Keep Antimatter running with Remote connections enabled, " +
                    "and connect the phone to the same network or VPN.", true, cause = error)
        }
        if (error is java.io.IOException) {
            return RemoteWorkspaceException(RemoteFailureCode.NETWORK,
                "Cannot reach the computer. Check that both devices are on the same network or VPN, " +
                    "and that Remote connections uses the computer's reachable network address.", true, cause = error)
        }
        if (error is IllegalArgumentException || error is org.json.JSONException) {
            return RemoteWorkspaceException(RemoteFailureCode.MALFORMED_RESPONSE, "The host returned an invalid response.", false, cause = error)
        }
        return RemoteWorkspaceException(RemoteFailureCode.INTERNAL, "The remote request could not be completed.", false, cause = error)
    }

    private inline fun <reified T : Throwable> Throwable.hasCause(): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (current is T) return true
            current = current.cause
        }
        return false
    }

    private fun pinnedSocketFactory(pin: CertificatePin): SSLSocketFactory = SSLContext.getInstance("TLS").run {
        init(null, arrayOf(PinnedLeafTrustManager(pin)), SecureRandom())
        socketFactory
    }

    private fun pinnedHostnameVerifier(pin: CertificatePin): HostnameVerifier = HostnameVerifier { _, session ->
        runCatching { pin.matches(session.peerCertificates.first().encoded) }.getOrDefault(false)
    }

    private class PinnedLeafTrustManager(private val pin: CertificatePin) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("Client certificates are not accepted.")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("The host supplied no certificate.")
            leaf.checkValidity()
            if (!pin.matches(leaf.encoded)) throw CertificateException("The host certificate pin changed.")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private fun queryComponent(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name())
    private fun namedEndpoint(name: String, endpoint: WorkspaceEndpoint): WorkspaceEndpoint =
        WorkspaceEndpoint.parse(name.trim().take(80).ifEmpty { endpoint.name }, endpoint.baseUrl).getOrThrow()
    private fun pathSegment(value: String): String = queryComponent(value).replace("+", "%20")

    private fun requireIdentifier(value: String, label: String) {
        require(value.length in 1..128 && value.all { it.isLetterOrDigit() || it in "-_.:" }) { "The $label identifier is invalid." }
    }

    private companion object {
        const val JSON_CONTENT_TYPE = "application/json"
        const val MAX_ERROR_BYTES = 256 * 1024
        const val MAX_JSON_BYTES = 8 * 1024 * 1024
        const val MAX_EVENTS_BYTES = 2 * 1024 * 1024
        const val MAX_ASSET_BYTES = 64 * 1024 * 1024
    }
}
