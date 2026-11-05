package co.antimatter.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.RemoteWorkspace
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.domain.WorkspaceProject
import co.antimatter.app.ui.theme.ClayAccent
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayError
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClayRaised
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle
import co.antimatter.app.ui.theme.ClayWarning

@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
fun WorkspacesScreen(
    state: AntimatterUiState,
    onOpenDrawer: () -> Unit,
    onAdd: () -> Unit,
    onSelect: (String) -> Unit,
    onReconnect: (String) -> Unit,
    onForget: (String) -> Unit,
    onSelectProject: (String, String) -> Unit,
    onNewProjectChat: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var forgettingId by remember { mutableStateOf<String?>(null) }
    val forgetting = state.workspaces.firstOrNull { it.id == forgettingId }
    val canPair = !state.isRestoringHosts && state.pairingHostId == null

    Column(modifier = modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Remote workspaces", color = ClayText) },
            navigationIcon = {
                IconButton(onClick = onOpenDrawer) {
                    Icon(Icons.Outlined.Menu, contentDescription = "Open navigation", tint = ClayTextMuted)
                }
            },
            actions = {
                IconButton(onClick = onAdd, enabled = canPair) {
                    Icon(Icons.Outlined.Add, contentDescription = "Pair a computer", tint = ClayPrimary)
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = ClaySurface),
        )

        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (state.isRestoringHosts) {
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text("Reconnecting to your computers…", color = ClayTextMuted)
                    }
                }
            } else if (state.workspaces.isEmpty()) {
                item {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Icon(Icons.Outlined.Dns, contentDescription = null, tint = ClayPrimary, modifier = Modifier.size(40.dp))
                        Text("Your computer. In your pocket.", color = ClayText, style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "Bring your Antimatter projects and conversations to your phone. Your models and tools keep running on your computer.",
                            color = ClayTextMuted,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Text(
                            "Connect both devices to the same Wi-Fi or VPN. On your computer, open Settings → Connections → Add device, then scan the QR code here.",
                            color = ClayTextMuted,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Button(
                            onClick = onAdd,
                            enabled = canPair,
                            colors = ButtonDefaults.buttonColors(containerColor = ClayPrimary, contentColor = Color.Black),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Pair a computer")
                        }
                    }
                }
            } else {
                item {
                    Text(
                        "Choose a project to continue a conversation or start a new one. Keep Antimatter running on your computer.",
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            items(state.workspaces, key = { it.id }) { workspace ->
                WorkspaceCard(
                    workspace = workspace,
                    selected = workspace.id == state.activeWorkspaceId,
                    projects = state.projects.filter { it.hostId == workspace.id },
                    selectedProjectId = state.activeProjectId.takeIf { workspace.id == state.activeWorkspaceId },
                    pairing = state.pairingHostId == workspace.id,
                    canPair = canPair,
                    onSelect = { onSelect(workspace.id) },
                    onReconnect = { onReconnect(workspace.id) },
                    onPair = onAdd,
                    onForget = { forgettingId = workspace.id },
                    onSelectProject = { onSelectProject(workspace.id, it) },
                    onNewProjectChat = { onNewProjectChat(workspace.id, it) },
                )
            }
        }
    }

    if (forgetting != null) {
        AlertDialog(
            onDismissRequest = { forgettingId = null },
            title = { Text("Forget ${forgetting.name}?") },
            text = { Text("This removes the saved connection and its chats from this phone. Projects and conversations on your computer stay there. You can pair again later.") },
            confirmButton = {
                TextButton(onClick = {
                    onForget(forgetting.id)
                    forgettingId = null
                }) { Text("Forget computer", color = ClayError) }
            },
            dismissButton = {
                TextButton(onClick = { forgettingId = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun WorkspaceCard(
    workspace: RemoteWorkspace,
    selected: Boolean,
    projects: List<WorkspaceProject>,
    selectedProjectId: String?,
    pairing: Boolean,
    canPair: Boolean,
    onSelect: () -> Unit,
    onReconnect: () -> Unit,
    onPair: () -> Unit,
    onForget: () -> Unit,
    onSelectProject: (String) -> Unit,
    onNewProjectChat: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val busy = workspace.phase == ConnectionPhase.CONNECTING || pairing
    val statusColor = when (workspace.phase) {
        ConnectionPhase.ONLINE -> ClayAccent
        ConnectionPhase.CONNECTING -> ClayWarning
        ConnectionPhase.ERROR -> ClayError
        ConnectionPhase.OFFLINE -> ClayTextSubtle
    }
    val statusLabel = when {
        pairing -> "Pairing"
        workspace.requiresPairing -> "Pair again"
        else -> when (workspace.phase) {
            ConnectionPhase.ONLINE -> "Online"
            ConnectionPhase.CONNECTING -> "Connecting"
            ConnectionPhase.ERROR -> "Connection failed"
            ConnectionPhase.OFFLINE -> "Offline"
        }
    }
    Surface(
        color = ClayRaised,
        contentColor = ClayText,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, if (selected) ClayPrimary else ClayBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f).clickable(onClick = onSelect)) {
                    Text(workspace.name, color = ClayText, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (busy) {
                            CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.dp, color = statusColor)
                        } else {
                            Surface(shape = CircleShape, color = statusColor, modifier = Modifier.size(7.dp)) {}
                        }
                        Spacer(Modifier.width(6.dp))
                        Text(statusLabel, color = statusColor, style = MaterialTheme.typography.labelMedium)
                        if (workspace.isPreview) {
                            Text(" · Preview", color = ClayTextSubtle, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
                if (selected) {
                    Icon(Icons.Outlined.Check, contentDescription = "Selected computer", tint = ClayPrimary, modifier = Modifier.size(18.dp))
                }
                Box {
                    IconButton(onClick = { menuOpen = true }, enabled = !busy) {
                        Icon(Icons.Outlined.MoreHoriz, contentDescription = "Options for ${workspace.name}", tint = ClayTextMuted)
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Forget computer") },
                            onClick = {
                                menuOpen = false
                                onForget()
                            },
                        )
                    }
                }
            }
            Text(
                workspace.baseUrl,
                color = ClayTextSubtle,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (workspace.detail.isNotBlank()) {
                Text(
                    workspace.detail,
                    color = if (workspace.phase == ConnectionPhase.ERROR) ClayError else ClayTextMuted,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (!busy && workspace.phase != ConnectionPhase.ONLINE) {
                Text(
                    if (workspace.requiresPairing) {
                        "Open Add device on your computer for a fresh QR code."
                    } else {
                        "Check that Antimatter is running and both devices are on the same Wi-Fi or VPN."
                    },
                    color = ClayTextMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!workspace.requiresPairing) {
                        TextButton(onClick = onReconnect) { Text("Retry connection") }
                    }
                    TextButton(onClick = onPair, enabled = canPair) { Text("Pair again") }
                }
            }
            if (projects.isNotEmpty()) {
                HorizontalDivider(color = ClayBorder)
                Text("Projects", color = ClayTextMuted, style = MaterialTheme.typography.labelLarge)
                projects.forEach { project ->
                    ProjectRow(
                        project = project,
                        selected = project.id == selectedProjectId,
                        canCreate = workspace.phase == ConnectionPhase.ONLINE &&
                            WorkspaceCapability.CHAT in workspace.capabilities &&
                            WorkspaceCapability.CHAT in project.capabilities,
                        onOpen = { onSelectProject(project.id) },
                        onNewChat = { onNewProjectChat(project.id) },
                    )
                }
            } else if (workspace.phase == ConnectionPhase.ONLINE) {
                Text(
                    "No projects are shared yet. Add a project in Antimatter on your computer, then refresh.",
                    color = ClayTextMuted,
                    style = MaterialTheme.typography.bodyMedium,
                )
                TextButton(onClick = onReconnect) { Text("Refresh projects") }
            }
        }
    }
}

@Composable
private fun ProjectRow(
    project: WorkspaceProject,
    selected: Boolean,
    canCreate: Boolean,
    onOpen: () -> Unit,
    onNewChat: () -> Unit,
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(Icons.Outlined.FolderOpen, contentDescription = null, tint = ClayTextMuted, modifier = Modifier.size(20.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(project.name, color = ClayText, style = MaterialTheme.typography.bodyLarge)
                project.locationHint?.takeIf { it.isNotBlank() }?.let {
                    Text(it, color = ClayTextSubtle, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (selected) Icon(Icons.Outlined.Check, contentDescription = "Selected project", tint = ClayPrimary, modifier = Modifier.size(18.dp))
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onOpen) { Text("Open chats") }
            TextButton(onClick = onNewChat, enabled = canCreate) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("New chat")
            }
        }
    }
}
