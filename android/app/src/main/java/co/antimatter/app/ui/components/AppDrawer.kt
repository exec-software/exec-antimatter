package co.antimatter.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import co.antimatter.app.R
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.AppDestination
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.ThreadKey
import co.antimatter.app.ui.theme.ClayAccent
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClaySurfaceAlt
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle

@Composable
fun AppDrawer(
    state: AntimatterUiState,
    onNewChat: () -> Unit,
    onNavigate: (AppDestination) -> Unit,
    onSelectConversation: (ThreadKey) -> Unit,
    onSelectProject: (String, String) -> Unit,
    onSearch: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    ModalDrawerSheet(
        modifier = modifier.width(312.dp).fillMaxHeight(),
        drawerContainerColor = ClaySurface,
        drawerContentColor = ClayText,
    ) {
        Column(modifier = Modifier.fillMaxHeight()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AtomMark(Modifier.size(28.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "ANTIMATTER",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.4.sp,
                    color = ClayText,
                )
                Spacer(Modifier.weight(1f))
                val connectionLabel = when (state.activeWorkspace?.phase) {
                    ConnectionPhase.ONLINE -> "Online"
                    ConnectionPhase.ERROR -> "Connection error"
                    ConnectionPhase.CONNECTING -> "Connecting"
                    ConnectionPhase.OFFLINE, null -> "Offline"
                }
                Surface(
                    shape = CircleShape,
                    color = when (state.activeWorkspace?.phase) {
                        ConnectionPhase.ONLINE -> ClayAccent
                        ConnectionPhase.ERROR -> MaterialTheme.colorScheme.error
                        else -> ClayTextSubtle
                    },
                    modifier = Modifier.size(8.dp).semantics {
                        contentDescription = "Workspace connection"
                        stateDescription = connectionLabel
                    },
                ) {}
            }

            DrawerAction(
                label = "New chat",
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                selected = false,
                onClick = onNewChat,
            )
            DrawerAction(
                label = "Chats",
                icon = { Icon(Icons.AutoMirrored.Outlined.Chat, contentDescription = null) },
                selected = state.destination == AppDestination.CHAT,
                onClick = { onNavigate(AppDestination.CHAT) },
            )
            DrawerAction(
                label = "Models",
                icon = { Icon(Icons.Outlined.Memory, contentDescription = null) },
                selected = state.destination == AppDestination.MODELS,
                onClick = { onNavigate(AppDestination.MODELS) },
            )
            DrawerAction(
                label = "Remote workspaces",
                icon = { Icon(Icons.Outlined.Dns, contentDescription = null) },
                selected = state.destination == AppDestination.WORKSPACES,
                onClick = { onNavigate(AppDestination.WORKSPACES) },
            )

            TextField(
                value = state.search,
                onValueChange = onSearch,
                placeholder = { Text("Search conversations", color = ClayTextSubtle) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = ClaySurfaceAlt,
                    unfocusedContainerColor = ClaySurfaceAlt,
                    focusedTextColor = ClayText,
                    unfocusedTextColor = ClayText,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            )

            HorizontalDivider(color = ClayBorder, thickness = DividerDefaults.Thickness)

            val query = state.search.trim()
            val matches = remember(state.conversations, query) {
                state.conversations.filter { !it.archived && (query.isEmpty() || it.title.contains(query, ignoreCase = true)) }
            }
            val pinned = matches.filter { it.pinned }
            val projects = state.projects.filter { query.isEmpty() || it.name.contains(query, ignoreCase = true) }

            LazyColumn(
                modifier = Modifier.weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 10.dp),
            ) {
                if (pinned.isNotEmpty()) {
                    item { DrawerSectionLabel("Pinned") }
                    items(pinned, key = { "pinned:${it.threadKey.hostId}:${it.threadKey.threadId}" }) { conversation ->
                        ConversationRow(conversation, conversation.threadKey == state.activeConversationKey, onSelectConversation)
                    }
                }

                if (projects.isNotEmpty()) {
                    item { DrawerSectionLabel("Projects") }
                    items(projects.sortedBy { it.name }, key = { "project:${it.hostId}:${it.id}" }) { project ->
                        NavigationDrawerItem(
                            label = {
                                Column {
                                    Text(project.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    if (state.workspaces.size > 1) {
                                        Text(
                                            state.workspaces.firstOrNull { it.id == project.hostId }?.name ?: "Computer",
                                            color = ClayTextSubtle,
                                            style = MaterialTheme.typography.labelSmall,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            },
                            icon = { Icon(Icons.Outlined.FolderOpen, contentDescription = null, modifier = Modifier.size(18.dp)) },
                            selected = state.activeWorkspaceId == project.hostId && state.activeProjectId == project.id,
                            onClick = { onSelectProject(project.hostId, project.id) },
                            shape = MaterialTheme.shapes.small,
                            colors = NavigationDrawerItemDefaults.colors(
                                selectedContainerColor = ClaySurfaceAlt,
                                selectedIconColor = ClayPrimary,
                                selectedTextColor = ClayText,
                                unselectedContainerColor = Color.Transparent,
                                unselectedIconColor = ClayTextSubtle,
                                unselectedTextColor = ClayTextMuted,
                            ),
                            modifier = Modifier.padding(horizontal = 8.dp),
                        )
                    }
                }

                item { DrawerSectionLabel("Recent") }
                if (matches.isEmpty()) {
                    item {
                        Text(
                            when {
                                query.isNotEmpty() -> "No conversations found"
                                state.workspaces.isEmpty() -> "Pair a computer to see your chats"
                                else -> "Your conversations will appear here"
                            },
                            color = ClayTextSubtle,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                        )
                    }
                }
                items(
                    matches.filterNot { it.pinned }.sortedByDescending { it.updatedAtMillis },
                    key = { "recent:${it.threadKey.hostId}:${it.threadKey.threadId}" },
                ) { conversation ->
                    ConversationRow(conversation, conversation.threadKey == state.activeConversationKey, onSelectConversation)
                }
            }

            HorizontalDivider(color = ClayBorder)
            DrawerAction(
                label = "Settings",
                icon = { Icon(Icons.Outlined.Settings, contentDescription = null) },
                selected = state.destination == AppDestination.SETTINGS,
                onClick = { onNavigate(AppDestination.SETTINGS) },
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.SmartToy, contentDescription = null, tint = ClayTextSubtle, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    stringResource(R.string.android_release_label, stringResource(R.string.android_public_version)),
                    color = ClayTextSubtle,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
    }
}

@Composable
private fun DrawerAction(
    label: String,
    icon: @Composable () -> Unit,
    selected: Boolean,
    onClick: () -> Unit,
) {
    NavigationDrawerItem(
        label = { Text(label, maxLines = 1) },
        icon = icon,
        selected = selected,
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        colors = NavigationDrawerItemDefaults.colors(
            selectedContainerColor = ClaySurfaceAlt,
            selectedIconColor = ClayPrimary,
            selectedTextColor = ClayText,
            unselectedContainerColor = Color.Transparent,
            unselectedIconColor = ClayTextSubtle,
            unselectedTextColor = ClayTextMuted,
        ),
        modifier = Modifier.padding(horizontal = 8.dp),
    )
}

@Composable
private fun DrawerSectionLabel(label: String) {
    Text(
        text = label.uppercase(),
        color = ClayTextSubtle,
        style = MaterialTheme.typography.labelMedium,
        letterSpacing = 0.8.sp,
        modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 6.dp),
    )
}

@Composable
private fun ConversationRow(
    conversation: Conversation,
    selected: Boolean,
    onSelect: (ThreadKey) -> Unit,
) {
    NavigationDrawerItem(
        label = {
            Column {
                Text(
                    conversation.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    conversation.project,
                    maxLines = 1,
                    color = ClayTextMuted,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        },
        selected = selected,
        onClick = { onSelect(conversation.threadKey) },
        shape = MaterialTheme.shapes.small,
        colors = NavigationDrawerItemDefaults.colors(
            selectedContainerColor = ClaySurfaceAlt,
            selectedTextColor = ClayText,
            unselectedContainerColor = Color.Transparent,
            unselectedTextColor = ClayTextMuted,
        ),
        modifier = Modifier.padding(horizontal = 8.dp),
    )
}
