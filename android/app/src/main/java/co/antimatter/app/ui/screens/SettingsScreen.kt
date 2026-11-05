package co.antimatter.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import co.antimatter.app.R
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayRaised
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle

@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
fun SettingsScreen(
    versionName: String,
    onOpenDrawer: () -> Unit,
    onWorkspaces: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Settings", color = ClayText) },
            navigationIcon = {
                IconButton(onClick = onOpenDrawer) {
                    Icon(Icons.Outlined.Menu, contentDescription = "Open navigation", tint = ClayTextMuted)
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = ClaySurface),
        )
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                Text(
                    "Mobile",
                    color = ClayTextSubtle,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
                )
            }
            item { SettingsRow(Icons.Outlined.CloudSync, "Remote workspaces", "Pair computers, retry connections, or forget a device", onWorkspaces) }
            item { SettingsInfo(Icons.Outlined.Lock, "Device security", "Pairing pins your computer's HTTPS certificate. Credentials are encrypted with Android Keystore. Revoke this phone in desktop Settings → Connections.") }
            item { SettingsInfo(Icons.Outlined.NotificationsNone, "Background activity", "Tasks keep running on your computer. Reopen the app to catch up. Push notifications and background approval alerts are not available yet.") }
            item { SettingsInfo(Icons.Outlined.Storage, "Drafts and history", "Unsent text is encrypted on this phone and restored for paired computers. Sending clears the saved text after the computer accepts it. Forgetting a computer removes its drafts; conversation history stays on the computer.") }
            item { SettingsInfo(Icons.Outlined.Info, "Desktop-only controls", "Manage providers, skills, plugins, schedules, pull requests, and subagents on your computer. File upload, terminal sessions, and voice input are not available on mobile yet.") }
            item {
                Text(
                    "About",
                    color = ClayTextSubtle,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
                )
            }
            item {
                SettingsInfo(
                    Icons.Outlined.Info,
                    "Antimatter for Android",
                    stringResource(R.string.android_release_details, stringResource(R.string.android_public_version), versionName),
                )
            }
        }
    }
}

@Composable
private fun SettingsInfo(icon: ImageVector, title: String, detail: String) {
    Surface(color = ClayRaised, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            Icon(icon, contentDescription = null, tint = ClayTextMuted, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(14.dp))
            Column {
                Text(title, color = ClayText, style = MaterialTheme.typography.bodyLarge)
                Text(detail, color = ClayTextMuted, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun SettingsRow(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        color = ClayRaised,
        contentColor = ClayText,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, ClayBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = ClayTextMuted, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = ClayText, style = MaterialTheme.typography.bodyLarge)
                Text(subtitle, color = ClayTextMuted, style = MaterialTheme.typography.bodyMedium)
            }
            Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = ClayTextSubtle)
        }
    }
}
