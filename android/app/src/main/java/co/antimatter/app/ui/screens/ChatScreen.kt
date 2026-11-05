package co.antimatter.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.domain.ToolActivity
import co.antimatter.app.domain.ThreadKey
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.domain.FollowUpSuggestion
import co.antimatter.app.domain.followUpSuggestion
import co.antimatter.app.ui.components.ChatComposer
import co.antimatter.app.ui.components.Transcript
import co.antimatter.app.ui.theme.ClayAccent
import co.antimatter.app.ui.theme.ClayError
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClaySurfaceAlt
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle

@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
fun ChatScreen(
    state: AntimatterUiState,
    onOpenDrawer: () -> Unit,
    onDraftChange: (String) -> Unit,
    onAccess: () -> Unit,
    onModel: () -> Unit,
    onAcceptSuggestion: (FollowUpSuggestion) -> Unit,
    onSend: () -> Unit,
    onSteer: () -> Unit,
    onStop: () -> Unit,
    onRename: (ThreadKey, String) -> Unit,
    onTogglePinned: (ThreadKey) -> Unit,
    onDelete: (ThreadKey) -> Unit,
    onResolveApproval: (ToolActivity, Boolean) -> Unit,
    onOpenPreview: (PreviewRef) -> Unit,
    onWorkspaces: () -> Unit,
    onPair: () -> Unit,
    onReconnect: (String) -> Unit,
    onNewChat: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val conversation = state.activeConversation
    val workspace = state.activeWorkspace
    val suggestion = state.followUpSuggestion()
    var menuOpen by remember(conversation?.threadKey) { mutableStateOf(false) }
    var dialog by remember(conversation?.threadKey) { mutableStateOf<String?>(null) }
    var titleDraft by remember(conversation?.threadKey) { mutableStateOf("") }
    if (conversation != null && dialog != null) {
        val deleting = dialog == "delete"
        AlertDialog(
            onDismissRequest = { dialog = null },
            title = { Text(if (deleting) "Delete conversation?" else "Rename conversation") },
            text = {
                if (deleting) Text("Delete “${conversation.title}” from your computer and connected devices? This cannot be undone.")
                else OutlinedTextField(
                    value = titleDraft, onValueChange = { titleDraft = it.take(240) },
                    label = { Text("Conversation name") }, singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    enabled = state.canManageActiveConversation && (deleting || titleDraft.isNotBlank()),
                    onClick = {
                        if (deleting) onDelete(conversation.threadKey) else onRename(conversation.threadKey, titleDraft)
                        dialog = null
                    },
                ) { Text(if (deleting) "Delete" else "Save", color = if (deleting) ClayError else ClayPrimary) }
            },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
        )
    }
    Column(modifier = modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(
                        conversation?.title ?: "Antimatter",
                        color = ClayText,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    WorkspaceStatus(
                        name = state.activeWorkspace?.name ?: "No workspace",
                        phase = state.activeWorkspace?.phase ?: ConnectionPhase.OFFLINE,
                        preview = state.activeWorkspace?.isPreview == true,
                    )
                }
            },
            navigationIcon = {
                IconButton(onClick = onOpenDrawer) {
                    Icon(Icons.Outlined.Menu, contentDescription = "Open navigation", tint = ClayTextMuted)
                }
            },
            actions = {
                Box {
                    IconButton(onClick = { menuOpen = true }, enabled = conversation != null) {
                        Icon(Icons.Outlined.MoreHoriz, contentDescription = "Conversation options", tint = ClayTextMuted)
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        if (!state.canManageActiveConversation) {
                            DropdownMenuItem(text = { Text(when {
                                state.isStreaming -> "Stop the response to edit this chat"
                                state.activeConversationKey in state.pendingThreadChanges -> "Updating conversation…"
                                else -> "Reconnect with chat access to edit"
                            }) }, enabled = false, onClick = {})
                        }
                        DropdownMenuItem(text = { Text("Rename") }, enabled = state.canManageActiveConversation,
                            onClick = { titleDraft = conversation?.title.orEmpty(); dialog = "rename"; menuOpen = false })
                        DropdownMenuItem(text = { Text(if (conversation?.pinned == true) "Unpin" else "Pin") },
                            enabled = state.canManageActiveConversation,
                            onClick = { conversation?.threadKey?.let(onTogglePinned); menuOpen = false })
                        DropdownMenuItem(text = { Text("Delete", color = ClayError) }, enabled = state.canManageActiveConversation,
                            onClick = { dialog = "delete"; menuOpen = false })
                    }
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = ClaySurface),
        )

        if (conversation == null) {
            ChatStart(
                state = state,
                onWorkspaces = onWorkspaces,
                onPair = onPair,
                onReconnect = onReconnect,
                onNewChat = onNewChat,
                modifier = Modifier.weight(1f),
            )
            return@Column
        }

        if (workspace?.phase != ConnectionPhase.ONLINE) {
            Surface(color = ClaySurfaceAlt, modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                    Text(
                        workspace?.detail?.takeIf { it.isNotBlank() } ?: "Connect to your computer to continue this chat.",
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row {
                        if (workspace != null && workspace.phase != ConnectionPhase.CONNECTING) {
                            if (workspace.requiresPairing) {
                                TextButton(onClick = onPair, enabled = state.pairingHostId == null) { Text("Pair again") }
                            } else {
                                TextButton(onClick = { onReconnect(workspace.id) }) { Text("Retry connection") }
                            }
                        }
                        TextButton(onClick = onWorkspaces) { Text("Remote workspaces") }
                    }
                }
            }
        }

        Transcript(
            conversation = conversation,
            isStreaming = state.isStreaming,
            activeTurn = state.activeTurn,
            onResolveApproval = onResolveApproval,
            onOpenPreview = onOpenPreview,
            modifier = Modifier.weight(1f),
        )

        ChatComposer(
            text = state.draft.text,
            accessMode = conversation.accessMode,
            model = state.activeModel,
            workspace = state.activeWorkspace,
            isStreaming = state.isStreaming,
            canSend = state.canSend,
            canSteer = state.canSteer,
            suggestion = suggestion?.text,
            onTextChange = onDraftChange,
            onAccess = onAccess,
            onModel = onModel,
            onAcceptSuggestion = { suggestion?.let(onAcceptSuggestion) },
            onSend = onSend,
            onSteer = onSteer,
            onStop = onStop,
        )
        if (workspace?.phase == ConnectionPhase.ONLINE && state.activeModel == null) {
            TextButton(onClick = onModel, modifier = Modifier.fillMaxWidth()) {
                Text("Choose a model to send messages", color = ClayPrimary)
            }
        }
    }
}

@Composable
private fun ChatStart(
    state: AntimatterUiState,
    onWorkspaces: () -> Unit,
    onPair: () -> Unit,
    onReconnect: (String) -> Unit,
    onNewChat: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val host = state.activeWorkspace
    val project = state.projects.firstOrNull { it.hostId == host?.id && it.id == state.activeProjectId }
    val connecting = state.isRestoringHosts || host?.phase == ConnectionPhase.CONNECTING
    Column(
        modifier = modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (connecting) {
            CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 2.dp)
        } else {
            Icon(Icons.Outlined.Dns, contentDescription = null, tint = ClayTextSubtle, modifier = Modifier.size(40.dp))
        }
        Spacer(Modifier.height(20.dp))
        Text(
            when {
                connecting -> "Connecting to your computer"
                host == null -> "Take your projects with you"
                host.requiresPairing -> "Pair with ${host.name} again"
                host.phase != ConnectionPhase.ONLINE -> "Your computer is offline"
                project == null -> "Choose a project"
                else -> project.name
            },
            color = ClayText,
            style = MaterialTheme.typography.titleLarge,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            when {
                connecting -> "Your projects and chats will appear once connected."
                host == null -> "Pair Antimatter on your computer to open your projects, continue chats, and run tasks."
                host.requiresPairing -> "Open Settings → Connections → Add device on your computer, then scan its new QR code."
                host.phase != ConnectionPhase.ONLINE -> host.detail.ifBlank { "Keep Antimatter running and connect both devices to the same Wi-Fi or VPN." }
                project == null -> "Open Remote workspaces to choose where your next chat runs."
                else -> "Start a conversation in this project. Your computer runs the models and tools."
            },
            color = ClayTextMuted,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(20.dp))
        if (!connecting) {
            val canCreate = project != null && host?.phase == ConnectionPhase.ONLINE &&
                WorkspaceCapability.CHAT in host.capabilities && WorkspaceCapability.CHAT in project.capabilities
            Button(
                onClick = {
                    when {
                        host == null || host.requiresPairing -> onPair()
                        host.phase != ConnectionPhase.ONLINE -> onReconnect(host.id)
                        canCreate -> onNewChat()
                        else -> onWorkspaces()
                    }
                },
                enabled = state.pairingHostId == null,
                colors = ButtonDefaults.buttonColors(containerColor = ClayPrimary, contentColor = Color.Black),
            ) {
                Text(when {
                    host == null -> "Pair a computer"
                    host.requiresPairing -> "Pair again"
                    host.phase != ConnectionPhase.ONLINE -> "Retry connection"
                    canCreate -> "New chat"
                    else -> "Choose a project"
                })
            }
        }
        if (state.workspaces.isNotEmpty()) {
            TextButton(onClick = onWorkspaces) { Text("Remote workspaces") }
        }
    }
}

@Composable
private fun WorkspaceStatus(name: String, phase: ConnectionPhase, preview: Boolean) {
    val color = when (phase) {
        ConnectionPhase.ONLINE -> ClayAccent
        ConnectionPhase.ERROR -> ClayError
        ConnectionPhase.CONNECTING -> MaterialTheme.colorScheme.primary
        ConnectionPhase.OFFLINE -> ClayTextSubtle
    }
    val phaseLabel = when (phase) {
        ConnectionPhase.ONLINE -> "Online"
        ConnectionPhase.ERROR -> "Connection error"
        ConnectionPhase.CONNECTING -> "Connecting"
        ConnectionPhase.OFFLINE -> "Offline"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.semantics { stateDescription = phaseLabel },
    ) {
        Surface(shape = androidx.compose.foundation.shape.CircleShape, color = color, modifier = Modifier.size(7.dp)) {}
        Spacer(Modifier.width(6.dp))
        Text(
            if (preview) "$name · Preview · $phaseLabel" else "$name · $phaseLabel",
            color = ClayTextMuted,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
