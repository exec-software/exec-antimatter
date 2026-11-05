package co.antimatter.app.domain

import java.util.UUID

enum class AppDestination {
    CHAT,
    MODELS,
    WORKSPACES,
    SETTINGS,
    PREVIEW,
}

enum class AccessMode(val label: String) {
    READ("Read only"),
    ASK("Ask first"),
    FULL("Full access"),
}

enum class MessageRole {
    USER,
    ASSISTANT,
    SYSTEM,
}

enum class ToolTier {
    READ,
    WRITE,
    DANGER,
}

enum class ToolStatus {
    PENDING,
    RUNNING,
    DONE,
    FAILED,
    DENIED,
}

enum class PreviewKind {
    IMAGE,
    PAGE,
}

enum class ConnectionPhase {
    OFFLINE,
    CONNECTING,
    ONLINE,
    ERROR,
}

/** Stable routing identity. Host-local thread IDs must never be used as global map keys. */
data class ThreadKey(
    /** Null is reserved for the local, not-yet-paired conversation shell. */
    val hostId: String?,
    val threadId: String,
)

data class ProjectKey(
    val hostId: String,
    val projectId: String,
)

data class ModelKey(
    val providerId: String,
    val modelId: String,
)

data class InferenceModel(
    val workspaceId: String,
    val key: ModelKey,
    val name: String,
    val providerName: String,
    val architecture: String? = null,
    val quantization: String? = null,
    val contextWindow: Int? = null,
    val supportsVision: Boolean? = null,
    val localToWorkspace: Boolean = false,
)

data class RemoteHost(
    val id: String,
    val name: String,
    val baseUrl: String,
    val phase: ConnectionPhase,
    val detail: String,
    val capabilities: Set<WorkspaceCapability> = emptySet(),
    val isPreview: Boolean = false,
    /** Pairing never completed, or the desktop revoked this device's credential. */
    val requiresPairing: Boolean = false,
)

/**
 * Compatibility name for the alpha shell. A remote connection is a host; the projects it exposes
 * are represented by [WorkspaceProject]. New transport code must use [RemoteHost].
 */
typealias RemoteWorkspace = RemoteHost

data class WorkspaceProject(
    val id: String,
    val hostId: String,
    val name: String,
    /** Human-readable hint only. The host never sends an absolute filesystem path to mobile. */
    val locationHint: String? = null,
    val revision: String,
    val capabilities: Set<WorkspaceCapability> = emptySet(),
    val isDefault: Boolean = false,
)

enum class WorkspaceCapability {
    CHAT,
    FILES,
    PREVIEWS,
    TERMINAL,
    ORCHESTRATOR,
    APPROVALS,
}

data class Attachment(
    val id: String,
    val name: String,
    val size: Long,
    val mediaType: String = "application/octet-stream",
    /** Opaque upload identifier. Mobile never receives an absolute host path. */
    val assetId: String? = null,
)

sealed interface PreviewRef {
    val id: String
    val title: String

    /** Authenticated content resolved only through the owning workspace transport. */
    data class Asset(
        override val id: String,
        override val title: String,
        val kind: PreviewKind,
        val assetId: String,
        /** Owning host is explicit so switching hosts cannot redirect an authenticated fetch. */
        val hostId: String? = null,
        val mediaType: String? = null,
        val size: Long? = null,
        val expiresAtMillis: Long? = null,
    ) : PreviewRef

    /** Public HTTPS destination. Workspace credentials must never be attached to this request. */
    data class ExternalPage(
        override val id: String,
        override val title: String,
        val url: String,
    ) : PreviewRef
}

data class ToolActivity(
    val callId: String,
    val activityId: String? = null,
    val approvalId: String? = null,
    val requestId: String,
    /** UTF-16 offset into the assistant text, matching desktop and Kotlin String indexing. */
    val contentOffset: Int? = null,
    val serverName: String,
    val toolName: String,
    val tier: ToolTier,
    val summary: String,
    val argumentsPreview: String,
    val status: ToolStatus,
    val resultPreview: String? = null,
    val awaitingApproval: Boolean = false,
    /** Host-redacted explanation of why this exact action needs approval. */
    val approvalReason: String? = null,
    /** Canonical, host-generated action description; unlike argumentsPreview it is not truncated. */
    val approvalDetails: String? = null,
    val preview: PreviewRef? = null,
)

data class ChatMessage(
    val id: String,
    val role: MessageRole,
    val content: String,
    val createdAtMillis: Long,
    val model: ModelKey? = null,
    val sourceName: String? = null,
    val attachments: List<Attachment> = emptyList(),
    val tools: List<ToolActivity> = emptyList(),
    val failed: Boolean = false,
)

data class Conversation(
    val id: String,
    val title: String,
    val project: String,
    val workspaceId: String?,
    val model: ModelKey?,
    val accessMode: AccessMode,
    val pinned: Boolean,
    val updatedAtMillis: Long,
    val messages: List<ChatMessage>,
    /**
     * Correct host identity. [workspaceId] remains during the alpha migration so the existing UI
     * keeps compiling; new remote code must route with hostId + projectId + thread id.
     */
    val hostId: String? = workspaceId,
    val projectId: String? = null,
    val revision: String? = null,
    val archived: Boolean = false,
) {
    val threadKey: ThreadKey
        get() = ThreadKey(hostId ?: workspaceId, id)
}

data class ConversationSummary(
    val id: String,
    val hostId: String,
    val projectId: String,
    val title: String,
    val pinned: Boolean,
    val archived: Boolean,
    val updatedAtMillis: Long,
    val revision: String,
    val activeRequestId: String? = null,
    val model: ModelKey? = null,
)

data class ComposerDraft(
    val text: String = "",
    val attachments: List<Attachment> = emptyList(),
)

data class ActiveTurn(
    val workspaceId: String,
    val threadId: String,
    val requestId: String,
    val responseMessageId: String,
    val projectId: String? = null,
    val startedAtMillis: Long? = null,
    val waiting: Boolean = false,
    val cancellationRequested: Boolean = false,
    val inference: TurnInference? = null,
)

data class AntimatterUiState(
    val destination: AppDestination = AppDestination.CHAT,
    val conversations: List<Conversation> = emptyList(),
    val activeConversationKey: ThreadKey? = null,
    val workspaces: List<RemoteWorkspace> = emptyList(),
    val activeWorkspaceId: String? = null,
    val projects: List<WorkspaceProject> = emptyList(),
    val activeProjectId: String? = null,
    val models: List<InferenceModel> = emptyList(),
    /** Drafts belong to threads so navigation never discards or leaks them across hosts. */
    val drafts: Map<ThreadKey, ComposerDraft> = emptyMap(),
    /** At most one live turn per thread; background threads may keep running. */
    val activeTurns: Map<ThreadKey, ActiveTurn> = emptyMap(),
    val search: String = "",
    val modelPickerOpen: Boolean = false,
    val accessPickerOpen: Boolean = false,
    val workspaceEditorOpen: Boolean = false,
    val isRestoringHosts: Boolean = false,
    val pairingHostId: String? = null,
    val pendingThreadChanges: Set<ThreadKey> = emptySet(),
    val openPreview: PreviewRef? = null,
    val notice: String? = null,
    /** Only transient connection errors have an owner; recovery must not erase other notices. */
    val connectionNoticeHostId: String? = null,
) {
    val activeConversation: Conversation?
        get() = activeConversationKey?.let { key -> conversations.firstOrNull { it.threadKey == key } }

    val activeWorkspace: RemoteWorkspace?
        get() {
            val hostId = activeConversation?.hostId ?: activeConversation?.workspaceId ?: activeWorkspaceId ?: return null
            return workspaces.firstOrNull { it.id == hostId }
        }

    val draft: ComposerDraft
        get() = activeConversationKey?.let(drafts::get) ?: ComposerDraft()

    val activeTurn: ActiveTurn?
        get() = activeConversationKey?.let(activeTurns::get)

    val isStreaming: Boolean
        get() = activeTurn != null

    val activeModel: InferenceModel?
        get() {
            val conversation = activeConversation ?: return null
            val selected = conversation.model ?: return null
            return models.firstOrNull { it.workspaceId == (conversation.hostId ?: conversation.workspaceId) && it.key == selected }
        }

    val canSend: Boolean
        get() = activeWorkspace?.phase == ConnectionPhase.ONLINE &&
            WorkspaceCapability.CHAT in activeWorkspace.orEmptyCapabilities() &&
            canChatInActiveProject &&
            activeModel != null &&
            draft.text.isNotBlank() &&
            activeTurn == null && activeConversationKey !in pendingThreadChanges

    val canSteer: Boolean
        get() = activeWorkspace?.phase == ConnectionPhase.ONLINE &&
            WorkspaceCapability.CHAT in activeWorkspace.orEmptyCapabilities() &&
            canChatInActiveProject &&
            draft.text.isNotBlank() &&
            activeTurn != null

    val canChatInActiveProject: Boolean
        get() = activeWorkspace?.isPreview == true || projects.any {
            it.hostId == activeWorkspace?.id && it.id == activeConversation?.projectId &&
                WorkspaceCapability.CHAT in it.capabilities
        }

    val canManageActiveConversation: Boolean
        get() = activeConversation != null && activeWorkspace?.phase == ConnectionPhase.ONLINE &&
            WorkspaceCapability.CHAT in activeWorkspace.orEmptyCapabilities() && canChatInActiveProject &&
            !isStreaming && activeConversationKey !in pendingThreadChanges

    private fun RemoteWorkspace?.orEmptyCapabilities(): Set<WorkspaceCapability> =
        this?.capabilities.orEmpty()
}

fun newConversation(
    workspaceId: String?,
    model: ModelKey?,
    project: String = "Inbox",
    projectId: String? = null,
    now: Long = System.currentTimeMillis(),
): Conversation = Conversation(
    id = UUID.randomUUID().toString(),
    title = "New conversation",
    project = project,
    workspaceId = workspaceId,
    model = model,
    accessMode = AccessMode.ASK,
    pinned = false,
    updatedAtMillis = now,
    messages = emptyList(),
    hostId = workspaceId,
    projectId = projectId,
)
