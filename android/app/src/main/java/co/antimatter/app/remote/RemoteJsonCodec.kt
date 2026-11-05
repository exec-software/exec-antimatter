package co.antimatter.app.remote

import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.ActiveTurn
import co.antimatter.app.domain.ChatMessage
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.ConversationSummary
import co.antimatter.app.domain.InferenceModel
import co.antimatter.app.domain.InferencePhase
import co.antimatter.app.domain.PromptProgress
import co.antimatter.app.domain.TurnInference
import co.antimatter.app.domain.MessageRole
import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.PreviewKind
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.domain.RemoteHost
import co.antimatter.app.domain.ToolActivity
import co.antimatter.app.domain.ToolStatus
import co.antimatter.app.domain.ToolTier
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.domain.WorkspaceProject
import org.json.JSONArray
import org.json.JSONObject

internal fun validateRemoteModelId(value: String): String = value.also {
    require(it.isNotBlank() && it.length <= 512 && it.none { character -> character.code < 0x20 || character.code == 0x7f }) {
        "modelId is invalid."
    }
}

internal fun parseRemoteApprovalResolution(value: String): ApprovalResolution =
    when (value.lowercase()) {
        "approved", "allowed" -> ApprovalResolution.APPROVED
        "declined" -> ApprovalResolution.DECLINED
        "expired" -> ApprovalResolution.EXPIRED
        "cancelled" -> ApprovalResolution.CANCELLED
        else -> ApprovalResolution.CANCELLED
    }

internal fun validateRemoteEventProtocolVersion(value: Int): Int = value.also {
    require(it == REMOTE_PROTOCOL_VERSION) { "The event uses an incompatible remote protocol." }
}

internal fun remoteCommandFailure(
    commandId: String,
    requestId: String?,
    code: String,
    userMessage: String,
    retryable: Boolean,
): WorkspaceEvent.CommandFailed = WorkspaceEvent.CommandFailed(
    commandId = commandId,
    requestId = requestId,
    code = code,
    userMessage = userMessage,
    retryable = retryable,
)

internal fun workspaceCommandKind(command: WorkspaceCommand): String = when (command) {
    is WorkspaceCommand.CreateThread -> "thread.create"
    is WorkspaceCommand.RenameThread -> "thread.rename"
    is WorkspaceCommand.SetThreadPinned -> "thread.set_pinned"
    is WorkspaceCommand.SetThreadModel -> "thread.set_model"
    is WorkspaceCommand.DeleteThread -> "thread.delete"
    is WorkspaceCommand.StartTurn -> "turn.start"
    is WorkspaceCommand.CancelTurn -> "turn.cancel"
    is WorkspaceCommand.SteerTurn -> "turn.steer"
    is WorkspaceCommand.ResolveApproval -> "approval.resolve"
}

internal fun workspaceCommandExpectedRevision(command: WorkspaceCommand): String? = when (command) {
    is WorkspaceCommand.RenameThread -> command.expectedRevision
    is WorkspaceCommand.SetThreadPinned -> command.expectedRevision
    is WorkspaceCommand.SetThreadModel -> command.expectedRevision
    is WorkspaceCommand.DeleteThread -> command.expectedRevision
    is WorkspaceCommand.StartTurn -> command.expectedRevision
    is WorkspaceCommand.CreateThread,
    is WorkspaceCommand.CancelTurn,
    is WorkspaceCommand.SteerTurn,
    is WorkspaceCommand.ResolveApproval -> null
}

internal object RemoteJsonCodec {
    fun pairingRequest(offer: PairingOffer, request: PairingRequest): String = JSONObject()
        .put("offerId", offer.offerId)
        .put("deviceName", request.deviceName)
        .put("clientVersion", request.clientVersion)
        .put("protocol", JSONObject().put("major", REMOTE_PROTOCOL_VERSION).put("minor", request.protocolMinor))
        .put("requestedCapabilities", JSONArray(request.requestedCapabilities.map(::capabilityName)))
        .toString()

    fun pairingResult(body: String, offer: PairingOffer): PairingResult {
        val root = JSONObject(body)
        val protocol = root.optJSONObject("protocol")
        val protocolVersion = protocol?.optInt("major", 0)
            ?: root.optInt("protocolVersion", 0)
        require(protocolVersion == REMOTE_PROTOCOL_VERSION) { "The host uses an incompatible remote protocol." }
        val hostJson = root.getJSONObject("host")
        val hostId = hostJson.requireId("id")
        require(hostId == offer.hostId) { "The paired host identity does not match the pairing offer." }
        require(hostJson.requireText("certificatePin") == offer.certificatePin.value) {
            "The paired certificate does not match the pairing offer."
        }
        val workspaceId = root.getJSONObject("workspace").requireId("id")
        val device = root.getJSONObject("device")
        val deviceId = device.requireId("id")
        val capabilities = parseCapabilities(device.optJSONArray("capabilities"))
        val credentialJson = root.getJSONObject("credential")
        require(credentialJson.getString("scheme") == "Bearer") { "The host returned an unsupported credential scheme." }
        val credential = WorkspaceCredential.create(
            bearerToken = credentialJson.getString("token"),
            deviceId = deviceId,
            workspaceId = workspaceId,
            certificatePin = offer.certificatePin,
        ).getOrThrow()
        return PairingResult(
            host = RemoteHost(
                id = hostId,
                name = hostJson.requireText("name"),
                baseUrl = offer.endpoint.baseUrl,
                phase = ConnectionPhase.ONLINE,
                detail = "Paired device • online",
                capabilities = capabilities,
            ),
            workspaceId = workspaceId,
            projects = emptyList(),
            credential = credential,
            grantedCapabilities = capabilities,
            protocolVersion = protocolVersion,
            hostVersion = root.optionalString("hostVersion"),
        )
    }

    fun command(command: WorkspaceCommand, workspaceId: String): String {
        val root = JSONObject()
            .put("protocolVersion", REMOTE_PROTOCOL_VERSION)
            .put("workspaceId", workspaceId)
            .put("projectId", command.projectId)
            .put("commandId", command.commandId)
            .put("kind", workspaceCommandKind(command))
        workspaceCommandExpectedRevision(command)?.let { root.put("expectedThreadRevision", it) }
        val payload = JSONObject()
        when (command) {
            is WorkspaceCommand.CreateThread -> {
                payload.put("clientThreadId", command.clientThreadId)
                    .put("title", command.title ?: "New conversation")
                command.model?.let { payload.put("model", model(it)) }
            }
            is WorkspaceCommand.RenameThread -> {
                payload.put("threadId", command.threadId).put("title", command.title)
            }
            is WorkspaceCommand.SetThreadPinned -> {
                payload.put("threadId", command.threadId).put("pinned", command.pinned)
            }
            is WorkspaceCommand.SetThreadModel -> {
                payload.put("threadId", command.threadId).put("model", model(command.model))
            }
            is WorkspaceCommand.DeleteThread -> {
                payload.put("threadId", command.threadId)
            }
            is WorkspaceCommand.StartTurn -> {
                payload.put("threadId", command.threadId)
                    .put("requestId", command.requestId)
                    .put("userMessageId", command.userMessageId)
                    .put("responseMessageId", command.responseMessageId)
                    .put("model", model(command.model))
                    .put("content", command.content)
                    .put("attachmentIds", JSONArray(command.attachmentIds))
                    .put("accessMode", command.accessMode.name.lowercase())
            }
            is WorkspaceCommand.CancelTurn -> {
                payload.put("requestId", command.requestId)
            }
            is WorkspaceCommand.SteerTurn -> {
                payload.put("requestId", command.requestId).put("note", command.note).put("now", command.now)
            }
            is WorkspaceCommand.ResolveApproval -> {
                payload.put("requestId", command.requestId)
                    .put("approvalId", command.approvalId)
                    .put("approved", command.decision == ApprovalDecision.ALLOW_ONCE)
            }
        }
        return root.put("payload", payload).toString()
    }

    fun commandReceipt(body: String): CommandReceipt {
        val response = JSONObject(body)
        val root = response.optJSONObject("receipt") ?: response
        val disposition = when (root.getString("disposition")) {
            "accepted" -> CommandDisposition.ACCEPTED
            "already_accepted" -> CommandDisposition.ALREADY_ACCEPTED
            "already_finished" -> CommandDisposition.ALREADY_FINISHED
            else -> error("The host returned an unknown command disposition.")
        }
        val result = root.optJSONObject("result")
        return CommandReceipt(
            commandId = root.requireId("commandId"),
            requestId = root.optionalString("requestId"),
            disposition = disposition,
            threadId = result?.optionalString("threadId") ?: root.optionalString("threadId"),
            clientThreadId = result?.optionalString("clientThreadId"),
            revision = root.optionalString("revision"),
        )
    }

    fun snapshot(body: String, endpoint: WorkspaceEndpoint): WorkspaceSnapshot {
        val root = JSONObject(body)
        val protocolVersion = root.optInt("protocolVersion", root.optJSONObject("protocol")?.optInt("major", 0) ?: 0)
        require(protocolVersion == REMOTE_PROTOCOL_VERSION) { "The host uses an incompatible remote protocol." }
        val hostJson = root.getJSONObject("host")
        val hostId = hostJson.requireId("id")
        val workspaceId = root.optJSONObject("workspace")?.requireId("id")
            ?: root.requireId("workspaceId")
        val projects = parseProjects(root.optJSONArray("projects"), hostId)
        val capabilities = parseCapabilities(root.optJSONArray("capabilities"))
        return WorkspaceSnapshot(
            host = RemoteHost(
                id = hostId,
                name = hostJson.requireText("name"),
                baseUrl = endpoint.baseUrl,
                phase = ConnectionPhase.ONLINE,
                detail = "Connected",
                capabilities = capabilities,
            ),
            workspaceId = workspaceId,
            protocolVersion = protocolVersion,
            hostVersion = root.optionalString("hostVersion"),
            revision = root.optString("revision", "0"),
            projects = projects,
            models = root.optJSONArray("models").mapObjects { parseModel(it, hostId) },
            conversations = (root.optJSONArray("conversations") ?: root.optJSONArray("threads"))
                .mapObjects { parseConversationSummary(it, hostId) },
            selectedThread = root.optJSONObject("selectedThread")?.let { parseThreadSnapshot(it, hostId) },
            activeTurns = root.optJSONArray("activeTurns").mapObjects { parseActiveTurn(it, hostId) },
            cursor = parseCursor(root.getJSONObject("cursor")),
        )
    }

    fun threadSnapshot(body: String, hostId: String): ThreadSnapshot = parseThreadSnapshot(JSONObject(body), hostId)

    fun attachmentRequest(projectId: String, request: AttachmentUploadRequest): String = JSONObject()
        .put("projectId", projectId)
        .put("name", request.name)
        .put("size", request.size)
        .put("mediaType", request.mediaType)
        .put("sha256", request.sha256Base64)
        .toString()

    fun attachmentUpload(body: String, hostId: String, projectId: String): AttachmentUpload {
        val root = JSONObject(body)
        return AttachmentUpload(
            hostId = hostId,
            projectId = projectId,
            uploadId = root.requireId("uploadId"),
            maxBytes = root.getLong("maxBytes"),
            expiresAtMillis = root.getLong("expiresAt"),
        )
    }

    fun remoteAsset(body: String, hostId: String): RemoteAsset {
        val root = JSONObject(body)
        return RemoteAsset(
            hostId = hostId,
            assetId = root.requireId("assetId"),
            mediaType = root.requireText("mediaType"),
            size = root.getLong("size"),
            sha256Base64 = root.requireText("sha256"),
            expiresAtMillis = root.optionalLong("expiresAt"),
        )
    }

    fun streamFrames(body: String, hostId: String, workspaceId: String): List<WorkspaceStreamFrame> {
        val root = JSONObject(body)
        if (root.optString("kind") == "reset") {
            return listOf(
                WorkspaceStreamFrame.Reset(
                    hostId = hostId,
                    reason = resetReason(root.optString("reason")),
                    snapshotRevision = root.optionalString("snapshotRevision"),
                    cursor = root.optJSONObject("cursor")?.let(::parseCursor),
                ),
            )
        }
        require(root.optString("kind") == "events") { "The host returned an unknown event replay kind." }
        val frames = root.optJSONArray("events") ?: JSONArray()
        return frames.mapObjects { parseEnvelope(it, hostId, workspaceId) }.map(WorkspaceStreamFrame::Event)
    }

    private fun parseEnvelope(
        root: JSONObject,
        authenticatedHostId: String,
        authenticatedWorkspaceId: String,
    ): WorkspaceEventEnvelope {
        require(root.requireId("workspaceId") == authenticatedWorkspaceId) {
            "An event was routed from a different workspace."
        }
        val event = root.getJSONObject("event")
        val kind = event.requireText("kind")
        val payload = event.optJSONObject("payload") ?: event
        return WorkspaceEventEnvelope(
            protocolVersion = validateRemoteEventProtocolVersion(
                event.optInt("protocolVersion", REMOTE_PROTOCOL_VERSION),
            ),
            hostId = authenticatedHostId,
            projectId = event.optionalString("projectId"),
            threadId = event.optionalString("threadId"),
            cursor = parseCursor(root.getJSONObject("cursor")),
            kind = kind,
            event = parseEvent(kind, payload, authenticatedHostId),
        )
    }

    private fun resetReason(raw: String): StreamResetReason = when (raw) {
        "missing_cursor" -> StreamResetReason.MISSING_CURSOR
        "epoch_changed" -> StreamResetReason.EPOCH_CHANGED
        "cursor_expired" -> StreamResetReason.CURSOR_EXPIRED
        "cursor_ahead" -> StreamResetReason.CURSOR_AHEAD
        else -> StreamResetReason.GAP
    }

    private fun parseEvent(kind: String, payload: JSONObject, hostId: String): WorkspaceEvent = when (kind) {
        "text.delta" -> WorkspaceEvent.TextDelta(
            requestId = payload.requireId("requestId"),
            responseMessageId = payload.requireId("responseMessageId"),
            content = payload.getString("content"),
        )
        "turn.liveness" -> WorkspaceEvent.Liveness(payload.requireId("requestId"), payload.getBoolean("waiting"))
        "tool.changed" -> WorkspaceEvent.ToolChanged(parseTool(payload.getJSONObject("activity"), hostId))
        "approval.requested" -> WorkspaceEvent.ApprovalRequested(parseTool(payload.getJSONObject("activity"), hostId))
        "approval.resolved" -> WorkspaceEvent.ApprovalResolved(
            payload.requireId("requestId"),
            payload.requireId("approvalId"),
            parseRemoteApprovalResolution(payload.getString("resolution")),
        )
        "steer.acknowledged" -> WorkspaceEvent.SteerAcknowledged(
            payload.requireId("requestId"),
            payload.requireId("commandId"),
        )
        "context.updated" -> WorkspaceEvent.ContextUpdated(
            payload.requireId("requestId"),
            payload.optionalLong("inputTokens"),
            payload.optionalLong("outputTokens"),
            payload.optionalLong("contextTokens"),
            payload.optionalLong("contextLimit"),
            payload.optJSONObject("inference")?.let(::parseInference),
        )
        "preview.ready" -> WorkspaceEvent.PreviewReady(
            requestId = payload.requireId("requestId"),
            responseMessageId = payload.optionalString("responseMessageId"),
            activityId = payload.optionalString("activityId"),
            preview = parsePreview(payload.getJSONObject("preview"), hostId),
        )
        "thread.changed" -> WorkspaceEvent.ThreadChanged(parseConversationSummary(payload, hostId))
        "thread.deleted" -> WorkspaceEvent.ThreadDeleted
        "catalog.changed" -> WorkspaceEvent.CatalogChanged(payload.requireText("revision"))
        "command.failed" -> remoteCommandFailure(
            commandId = payload.requireId("commandId"),
            requestId = payload.optionalString("requestId"),
            code = payload.optString("code", "dispatch_failed"),
            userMessage = payload.optString("userMessage", "The host could not apply that command."),
            retryable = payload.optBoolean("retryable", true),
        )
        "turn.finished" -> WorkspaceEvent.TurnFinished(
            payload.requireId("requestId"),
            payload.requireId("responseMessageId"),
            payload.optionalString("finishReason"),
        )
        "turn.failed" -> WorkspaceEvent.TurnFailed(
            requestId = payload.requireId("requestId"),
            responseMessageId = payload.optionalString("responseMessageId"),
            code = enumValueOrDefault(payload.optString("code").uppercase(), TurnFailureCode.INTERNAL),
            userMessage = payload.optString("userMessage", "The remote turn failed."),
            retryable = payload.optBoolean("retryable", false),
        )
        else -> WorkspaceEvent.Unknown(payload.toString())
    }

    private fun parseProjects(array: JSONArray?, hostId: String): List<WorkspaceProject> = array.mapObjects {
        WorkspaceProject(
            id = it.requireId("id"),
            hostId = hostId,
            name = it.requireText("name"),
            locationHint = it.optionalString("locationHint"),
            revision = it.optString("revision", "0"),
            capabilities = parseCapabilities(it.optJSONArray("capabilities")),
            isDefault = it.optBoolean("isDefault", false),
        )
    }

    private fun parseModel(root: JSONObject, hostId: String): InferenceModel = InferenceModel(
        workspaceId = hostId,
        key = ModelKey(root.requireId("providerId"), root.requireModelId("modelId")),
        name = root.requireText("name"),
        providerName = root.requireText("providerName"),
        architecture = root.optionalString("architecture"),
        quantization = root.optionalString("quantization"),
        contextWindow = root.optionalInt("contextWindow"),
        supportsVision = root.optionalBoolean("supportsVision"),
        localToWorkspace = root.optBoolean("localToHost", root.optBoolean("localToWorkspace", false)),
    )

    private fun parseConversationSummary(root: JSONObject, hostId: String): ConversationSummary {
        val model = root.optJSONObject("model")?.let(::parseModelKey) ?: run {
            val providerId = root.optionalString("providerId")
            val modelId = root.optionalString("modelId")
            if (providerId != null && modelId != null) ModelKey(providerId, validateRemoteModelId(modelId)) else null
        }
        return ConversationSummary(
            id = root.requireId("id"),
            hostId = hostId,
            projectId = root.requireId("projectId"),
            title = root.requireText("title"),
            pinned = root.optBoolean("pinned", false),
            archived = root.optBoolean("archived", false),
            updatedAtMillis = root.optLong("updatedAt", 0L),
            revision = root.optString("revision", "0"),
            activeRequestId = root.optionalString("activeRequestId"),
            model = model,
        )
    }

    private fun parseThreadSnapshot(root: JSONObject, hostId: String): ThreadSnapshot {
        val body = root.optJSONObject("conversation") ?: root
        val projectId = body.requireId("projectId")
        val model = body.optJSONObject("model")?.let(::parseModelKey) ?: run {
            val providerId = body.optionalString("providerId")
            val modelId = body.optionalString("modelId")
            if (providerId != null && modelId != null) ModelKey(providerId, modelId) else null
        }
        val conversation = Conversation(
            id = body.requireId("id"),
            title = body.requireText("title"),
            project = body.optString("projectName", "Project"),
            workspaceId = hostId,
            model = model,
            accessMode = enumValueOrDefault(body.optString("accessMode", "ask").uppercase(), AccessMode.ASK),
            pinned = body.optBoolean("pinned", false),
            updatedAtMillis = body.optLong("updatedAt", 0L),
            messages = body.optJSONArray("messages").mapObjects { parseMessage(it, hostId) },
            hostId = hostId,
            projectId = projectId,
            revision = body.optString("revision", root.optString("revision", "0")),
            archived = body.optBoolean("archived", false),
        )
        return ThreadSnapshot(
            hostId = hostId,
            projectId = projectId,
            conversation = conversation,
            revision = conversation.revision ?: "0",
            cursor = root.optJSONObject("cursor")?.let(::parseCursor),
        )
    }

    private fun parseMessage(root: JSONObject, hostId: String): ChatMessage = ChatMessage(
        id = root.requireId("id"),
        role = enumValueOrDefault(root.optString("role").uppercase(), MessageRole.SYSTEM),
        content = root.optString("content", ""),
        createdAtMillis = root.optLong("createdAt", 0L),
        model = root.optJSONObject("model")?.let(::parseModelKey),
        sourceName = root.optionalString("sourceName"),
        tools = root.optJSONArray("tools").mapObjects { parseTool(it, hostId) },
        failed = root.optBoolean("failed", false),
    )

    private fun parseActiveTurn(root: JSONObject, hostId: String): ActiveTurn = ActiveTurn(
        workspaceId = hostId,
        threadId = root.requireId("threadId"),
        requestId = root.requireId("requestId"),
        responseMessageId = root.requireId("responseMessageId"),
        projectId = root.optionalString("projectId"),
        startedAtMillis = root.optionalLong("startedAt"),
        waiting = root.optBoolean("waiting", false),
        cancellationRequested = root.optBoolean("cancellationRequested", false),
        inference = root.optJSONObject("inference")?.let(::parseInference),
    )

    private fun parseInference(root: JSONObject): TurnInference? {
        val phase = InferencePhase.entries.firstOrNull { it.name.equals(root.optString("phase"), ignoreCase = true) } ?: return null
        val round = root.nonnegativeCount("round")?.takeIf { it <= Int.MAX_VALUE }?.toInt() ?: return null
        val started = root.nonnegativeNumber("requestStartedAt") ?: return null
        val duration = root.nonnegativeNumber("requestDurationMs") ?: return null
        val progress = root.optJSONObject("promptProgress")?.let { value ->
            val total = value.nonnegativeCount("total") ?: return@let null
            val cached = value.nonnegativeCount("cached") ?: return@let null
            val processed = value.nonnegativeCount("processed") ?: return@let null
            val elapsed = value.nonnegativeNumber("elapsedMs") ?: return@let null
            if (cached > processed || processed > total) null else PromptProgress(total, cached, processed, elapsed)
        }
        return TurnInference(
            round, phase, started, duration, progress,
            root.nonnegativeCount("promptTokens"), root.nonnegativeCount("cachedPromptTokens"),
            root.nonnegativeCount("prefillTokens"), root.nonnegativeNumber("firstTokenMs"),
        )
    }

    private fun JSONObject.nonnegativeNumber(name: String): Double? = (opt(name) as? Number)?.toDouble()
        ?.takeIf { it.isFinite() && it >= 0 }

    private fun JSONObject.nonnegativeCount(name: String): Long? = nonnegativeNumber(name)
        ?.takeIf { it <= 9_007_199_254_740_991.0 && it % 1.0 == 0.0 }?.toLong()

    private fun parseTool(root: JSONObject, hostId: String): ToolActivity = ToolActivity(
        callId = root.requireId("callId"),
        activityId = root.optionalString("activityId"),
        approvalId = root.optionalString("approvalId"),
        requestId = root.requireId("requestId"),
        contentOffset = root.optionalInt("contentOffset"),
        serverName = root.optString("serverName", "Workspace"),
        toolName = root.requireText("toolName"),
        tier = enumValueOrDefault(root.optString("tier").uppercase(), ToolTier.READ),
        summary = root.optString("summary", root.requireText("toolName")),
        argumentsPreview = root.optString("argumentsPreview", ""),
        status = enumValueOrDefault(root.optString("status").uppercase(), ToolStatus.PENDING),
        resultPreview = root.optionalString("resultPreview"),
        awaitingApproval = root.optBoolean("awaitingApproval", false),
        approvalReason = root.optionalString("approvalReason"),
        approvalDetails = root.optionalString("approvalDetails"),
        preview = root.optJSONObject("preview")?.let { parsePreview(it, hostId) },
    )

    private fun parsePreview(root: JSONObject, hostId: String): PreviewRef = when (root.getString("kind")) {
        "external" -> PreviewRef.ExternalPage(root.requireId("id"), root.requireText("title"), root.requireText("url"))
        "image", "page", "asset" -> PreviewRef.Asset(
            id = root.requireId("id"),
            title = root.requireText("title"),
            kind = if (root.optString("previewKind", root.getString("kind")) == "image") PreviewKind.IMAGE else PreviewKind.PAGE,
            assetId = root.requireId("assetId"),
            hostId = hostId,
            mediaType = root.optionalString("mediaType"),
            size = root.optionalLong("size"),
            expiresAtMillis = root.optionalLong("expiresAt"),
        )
        else -> error("The host returned an unknown preview kind.")
    }

    private fun parseCapabilities(array: JSONArray?): Set<WorkspaceCapability> = buildSet {
        if (array == null) return@buildSet
        repeat(array.length()) { index ->
            when (array.optString(index)) {
                "chat" -> add(WorkspaceCapability.CHAT)
                "files" -> add(WorkspaceCapability.FILES)
                "previews" -> add(WorkspaceCapability.PREVIEWS)
                "terminal" -> add(WorkspaceCapability.TERMINAL)
                "orchestrator" -> add(WorkspaceCapability.ORCHESTRATOR)
                "approvals" -> add(WorkspaceCapability.APPROVALS)
            }
        }
    }

    private fun capabilityName(value: WorkspaceCapability): String = value.name.lowercase()
    private fun model(value: ModelKey): JSONObject = JSONObject().put("providerId", value.providerId).put("modelId", value.modelId)
    private fun parseModelKey(root: JSONObject): ModelKey =
        ModelKey(root.requireId("providerId"), root.requireModelId("modelId"))
    private fun parseCursor(root: JSONObject): EventCursor = EventCursor(root.requireId("epoch"), root.getLong("sequence"))

    private inline fun <reified T : Enum<T>> enumValueOrDefault(raw: String, fallback: T): T =
        enumValues<T>().firstOrNull { it.name == raw } ?: fallback

    private fun JSONObject.requireId(name: String): String = requireText(name).also { value ->
        require(value.length <= 128 && value.all { it.isLetterOrDigit() || it in "-_.:" }) { "$name is invalid." }
    }

    private fun JSONObject.requireText(name: String): String = getString(name).also {
        require(it.isNotBlank()) { "$name is required." }
    }

    /** Model catalog keys are opaque names, not routing IDs; `org/model` is a normal model key. */
    private fun JSONObject.requireModelId(name: String): String = validateRemoteModelId(requireText(name))

    private fun JSONObject.optionalString(name: String): String? =
        if (!has(name) || isNull(name)) null else getString(name)

    private fun JSONObject.optionalLong(name: String): Long? =
        if (!has(name) || isNull(name)) null else getLong(name)

    private fun JSONObject.optionalInt(name: String): Int? =
        if (!has(name) || isNull(name)) null else getInt(name)

    private fun JSONObject.optionalBoolean(name: String): Boolean? =
        if (!has(name) || isNull(name)) null else getBoolean(name)

    private inline fun <T> JSONArray?.mapObjects(transform: (JSONObject) -> T): List<T> {
        if (this == null) return emptyList()
        return List(length()) { index -> transform(getJSONObject(index)) }
    }
}
