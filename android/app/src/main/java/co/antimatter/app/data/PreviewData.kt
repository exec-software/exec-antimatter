package co.antimatter.app.data

import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.ChatMessage
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.InferenceModel
import co.antimatter.app.domain.MessageRole
import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.PreviewKind
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.domain.RemoteWorkspace
import co.antimatter.app.domain.ToolActivity
import co.antimatter.app.domain.ToolStatus
import co.antimatter.app.domain.ToolTier
import co.antimatter.app.domain.WorkspaceCapability

/**
 * Explicit test/UI fixture for inspecting the complete shell without a paired host. Every
 * surface names itself as a preview; installed debug and release builds start disconnected
 * and never select this fixture automatically.
 */
object PreviewData {
    private const val workspaceId = "preview-workspace"
    private val coder = ModelKey("preview-beholdd", "qwen3-coder-30b")

    fun state(): AntimatterUiState {
        val now = System.currentTimeMillis()
        val activity = ToolActivity(
            callId = "call-preview-1",
            activityId = "activity-preview-1",
            requestId = "request-preview-1",
            contentOffset = 88,
            serverName = "Workspace",
            toolName = "read_file",
            tier = ToolTier.READ,
            summary = "Read renderer/src/lib/transcript.ts",
            argumentsPreview = "{ path: renderer/src/lib/transcript.ts }",
            status = ToolStatus.DONE,
            resultPreview = "Mapped text and tool activity into one ordered transcript.",
            preview = PreviewRef.Asset(
                id = "preview-page-1",
                title = "Open rendered page",
                kind = PreviewKind.PAGE,
                assetId = "preview-asset-page-1",
            ),
        )
        val approval = ToolActivity(
            callId = "call-preview-2",
            activityId = "activity-preview-2",
            approvalId = "approval-preview-2",
            requestId = "request-preview-1",
            contentOffset = 211,
            serverName = "Workspace",
            toolName = "write_file",
            tier = ToolTier.WRITE,
            summary = "Update Android navigation",
            argumentsPreview = "{ path: android/app/src/main/.../AntimatterApp.kt }",
            status = ToolStatus.PENDING,
            awaitingApproval = true,
            approvalReason = "This preview action would modify one tracked source file on the host.",
            approvalDetails = "Write android/app/src/main/java/co/antimatter/app/ui/AntimatterApp.kt in the paired Antimatter workspace.",
        )
        val active = Conversation(
            id = "preview-android-foundation",
            title = "Android foundation",
            project = "Antimatter",
            workspaceId = workspaceId,
            model = coder,
            accessMode = AccessMode.ASK,
            pinned = true,
            updatedAtMillis = now,
            messages = listOf(
                ChatMessage(
                    id = "preview-user-1",
                    role = MessageRole.USER,
                    content = "Make the Android client feel like Antimatter, and keep it ready for remote workspaces.",
                    createdAtMillis = now - 90_000,
                ),
                ChatMessage(
                    id = "preview-assistant-1",
                    role = MessageRole.ASSISTANT,
                    content = "I started with the same flat Clay palette and the mobile conversation as the center of gravity. Tool activity stays beside the prose that caused it, while models and workspace authority remain explicit.\n\nThe transport boundary uses resumable, ordered events so a phone can sleep, reconnect, and continue without inventing transcript state.",
                    createdAtMillis = now - 50_000,
                    model = coder,
                    sourceName = "beholdd GPU (Preview)",
                    tools = listOf(activity, approval),
                ),
            ),
        )
        val recent = Conversation(
            id = "preview-remote-protocol",
            title = "Remote workspace protocol",
            project = "Antimatter",
            workspaceId = workspaceId,
            model = coder,
            accessMode = AccessMode.READ,
            pinned = false,
            updatedAtMillis = now - 3_600_000,
            messages = emptyList(),
        )

        return AntimatterUiState(
            conversations = listOf(active, recent),
            activeConversationKey = active.threadKey,
            workspaces = listOf(
                RemoteWorkspace(
                    id = workspaceId,
                    name = "UI Preview",
                    baseUrl = "https://preview.invalid",
                    phase = ConnectionPhase.ONLINE,
                    detail = "Local preview • no network",
                    capabilities = WorkspaceCapability.entries.toSet(),
                    isPreview = true,
                ),
            ),
            activeWorkspaceId = workspaceId,
            models = listOf(
                InferenceModel(
                    workspaceId = workspaceId,
                    key = coder,
                    name = "Qwen3-Coder 30B",
                    providerName = "beholdd GPU (Preview)",
                    architecture = "qwen3moe",
                    quantization = "Q8_0",
                    contextWindow = 262_144,
                    localToWorkspace = true,
                ),
                InferenceModel(
                    workspaceId = workspaceId,
                    key = ModelKey("preview-beholdd", "nemotron-super"),
                    name = "Nemotron Super",
                    providerName = "beholdd GPU (Preview)",
                    architecture = "nemotron_h_moe",
                    quantization = "FP8",
                    contextWindow = 131_072,
                    localToWorkspace = true,
                ),
                InferenceModel(
                    workspaceId = workspaceId,
                    key = ModelKey("preview-openai", "openai-default"),
                    name = "OpenAI default",
                    providerName = "OpenAI (Preview)",
                    contextWindow = 128_000,
                    supportsVision = true,
                ),
            ),
        )
    }
}
