package co.antimatter.app.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.DrawerValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.ContextCompat
import co.antimatter.app.BuildConfig
import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.AppDestination
import co.antimatter.app.ui.components.AppDrawer
import co.antimatter.app.ui.components.PairingQrScanner
import co.antimatter.app.ui.screens.ChatScreen
import co.antimatter.app.ui.screens.ModelsScreen
import co.antimatter.app.ui.screens.PreviewScreen
import co.antimatter.app.ui.screens.SettingsScreen
import co.antimatter.app.ui.screens.WorkspacesScreen
import co.antimatter.app.ui.theme.ClayPage
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClayRaised
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClaySurfaceAlt
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AntimatterApp(viewModel: AntimatterViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = remember(context) { context.getSystemService(ClipboardManager::class.java) }

    fun closeDrawer() {
        scope.launch { drawerState.close() }
    }

    LaunchedEffect(state.notice, state.connectionNoticeHostId) {
        val connectionHostId = state.connectionNoticeHostId
        val message = state.notice
        if (message == null) {
            snackbar.currentSnackbarData?.dismiss()
        } else {
            snackbar.showSnackbar(message)
            viewModel.dismissNotice(message, connectionHostId)
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            AppDrawer(
                state = state,
                onNewChat = {
                    viewModel.newChat()
                    closeDrawer()
                },
                onNavigate = {
                    viewModel.navigate(it)
                    closeDrawer()
                },
                onSelectConversation = {
                    viewModel.selectConversation(it)
                    closeDrawer()
                },
                onSelectProject = { hostId, projectId ->
                    viewModel.selectProject(hostId, projectId)
                    closeDrawer()
                },
                onSearch = viewModel::updateSearch,
            )
        },
    ) {
        Scaffold(
            containerColor = ClayPage,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            Box(modifier = Modifier.padding(padding)) {
                when (state.destination) {
                    AppDestination.CHAT -> ChatScreen(
                        state = state,
                        onOpenDrawer = { scope.launch { drawerState.open() } },
                        onDraftChange = viewModel::updateDraft,
                        onAccess = { viewModel.showAccessPicker(true) },
                        onModel = { viewModel.showModelPicker(true) },
                        onAcceptSuggestion = viewModel::acceptFollowUpSuggestion,
                        onSend = viewModel::send,
                        onSteer = viewModel::submitSteer,
                        onStop = viewModel::stopTurn,
                        onRename = viewModel::renameConversation,
                        onTogglePinned = viewModel::togglePinned,
                        onDelete = viewModel::deleteConversation,
                        onResolveApproval = viewModel::resolveApproval,
                        onOpenPreview = viewModel::openPreview,
                        onWorkspaces = { viewModel.navigate(AppDestination.WORKSPACES) },
                        onPair = { viewModel.showWorkspaceEditor(true) },
                        onReconnect = viewModel::reconnectWorkspace,
                        onNewChat = viewModel::newChat,
                    )

                    AppDestination.MODELS -> ModelsScreen(
                        state = state,
                        selectionMode = state.modelPickerOpen,
                        onOpenDrawer = { scope.launch { drawerState.open() } },
                        onBack = { viewModel.showModelPicker(false) },
                        onSelectModel = viewModel::selectModel,
                        onWorkspaces = { viewModel.navigate(AppDestination.WORKSPACES) },
                    )

                    AppDestination.WORKSPACES -> WorkspacesScreen(
                        state = state,
                        onOpenDrawer = { scope.launch { drawerState.open() } },
                        onAdd = { viewModel.showWorkspaceEditor(true) },
                        onSelect = viewModel::selectWorkspace,
                        onReconnect = viewModel::reconnectWorkspace,
                        onForget = viewModel::forgetWorkspace,
                        onSelectProject = viewModel::selectProject,
                        onNewProjectChat = { hostId, projectId ->
                            viewModel.selectProject(hostId, projectId)
                            viewModel.newChat()
                        },
                    )

                    AppDestination.SETTINGS -> SettingsScreen(
                        versionName = BuildConfig.VERSION_NAME,
                        onOpenDrawer = { scope.launch { drawerState.open() } },
                        onWorkspaces = { viewModel.navigate(AppDestination.WORKSPACES) },
                    )

                    AppDestination.PREVIEW -> PreviewScreen(
                        preview = state.openPreview,
                        onBack = viewModel::closePreview,
                    )
                }
            }
        }
    }

    BackHandler(enabled = state.modelPickerOpen) {
        viewModel.showModelPicker(false)
    }
    BackHandler(enabled = state.destination == AppDestination.PREVIEW) {
        viewModel.closePreview()
    }

    if (state.accessPickerOpen) {
        AccessSheet(
            selected = state.activeConversation?.accessMode ?: AccessMode.ASK,
            onSelect = viewModel::selectAccessMode,
            onDismiss = { viewModel.showAccessPicker(false) },
        )
    }

    if (state.workspaceEditorOpen) {
        WorkspacePairingSheet(
            onPairingCode = viewModel::pairWorkspace,
            onPaste = {
                val pairingCode = clipboard.primaryClip
                    ?.takeIf { it.itemCount > 0 }
                    ?.getItemAt(0)
                    ?.text
                    ?.toString()
                if (pairingCode.isNullOrBlank()) {
                    viewModel.notify("Copy the private pairing code from Antimatter on your computer first.")
                    false
                } else if (viewModel.pairWorkspace(pairingCode)) {
                    // Do not overwrite clipboard content that changed while the code was being
                    // accepted. The camera path never reads or writes the clipboard.
                    val current = clipboard.primaryClip
                        ?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)
                        ?.text
                        ?.toString()
                    if (shouldClearConsumedPairingCode(pairingCode, current)) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            clipboard.clearPrimaryClip()
                        } else {
                            clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
                        }
                    }
                    true
                } else false
            },
            onDismiss = { viewModel.showWorkspaceEditor(false) },
        )
    }
}

internal fun shouldClearConsumedPairingCode(consumed: String, current: String?): Boolean =
    consumed.isNotEmpty() && current == consumed

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccessSheet(
    selected: AccessMode,
    onSelect: (AccessMode) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = ClayRaised,
        contentColor = ClayText,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(
                "Workspace access",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
            )
            Text(
                "The remote host enforces this mode. Mobile cannot grant itself more authority.",
                color = ClayTextMuted,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            )
            AccessMode.entries.forEach { mode ->
                val (icon, detail) = when (mode) {
                    AccessMode.READ -> Icons.Outlined.Visibility to "Read the workspace without changing it"
                    AccessMode.ASK -> Icons.Outlined.Security to "Ask before writes and commands"
                    AccessMode.FULL -> Icons.Outlined.Lock to "Allow project changes; host safeguards still apply"
                }
                ListItem(
                    headlineContent = { Text(mode.label) },
                    supportingContent = { Text(detail, color = ClayTextSubtle) },
                    leadingContent = { Icon(icon, contentDescription = null, tint = ClayTextMuted) },
                    trailingContent = { RadioButton(selected = selected == mode, onClick = { onSelect(mode) }) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.fillMaxWidth().clickable { onSelect(mode) },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkspacePairingSheet(
    onPairingCode: (String) -> Boolean,
    onPaste: () -> Boolean,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    var scanning by rememberSaveable { mutableStateOf(false) }
    var guidance by rememberSaveable { mutableStateOf<String?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            guidance = null
            scanning = true
        } else {
            guidance = "Camera access was not granted. You can still paste the pairing code."
        }
    }

    fun startScanner() {
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            guidance = "This device has no available camera. Paste the pairing code instead."
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            guidance = null
            scanning = true
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = ClayRaised,
        contentColor = ClayText,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().heightIn(max = screenHeight * 0.9f)
                .imePadding().padding(horizontal = 20.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(
                modifier = Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (scanning) {
                    Text("Scan pairing code", style = MaterialTheme.typography.titleLarge)
                    PairingQrScanner(
                        onPairingCode = { rawValue ->
                            scanning = false
                            if (!onPairingCode(rawValue)) {
                                guidance = "That code could not be used. Show a fresh pairing QR on your computer and try again."
                            }
                        },
                        onGuidance = { guidance = it },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height((screenHeight * 0.4f).coerceIn(160.dp, 320.dp))
                            .clip(RoundedCornerShape(22.dp)),
                    )
                    Text(
                        guidance ?: "Point the camera at the QR code on your computer.",
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    Text("Pair a computer", style = MaterialTheme.typography.titleLarge)
                    Text(
                        "Connect both devices to the same Wi-Fi or VPN.",
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "On your computer, open Antimatter → Settings → Connections → Add device. Then scan the QR code here.",
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    guidance?.let {
                        Text(it, color = ClayTextMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (scanning) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { scanning = false }) { Text("Use paste instead", color = ClayTextMuted) }
                    Spacer(Modifier.width(8.dp))
                    TextButton(onClick = onDismiss) { Text("Cancel", color = ClayTextMuted) }
                }
            } else {
                Button(
                    onClick = ::startScanner,
                    colors = ButtonDefaults.buttonColors(containerColor = ClayPrimary, contentColor = Color.Black),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Scan QR code")
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Cancel", color = ClayTextMuted) }
                    Spacer(Modifier.width(4.dp))
                    TextButton(onClick = {
                        if (!onPaste()) guidance = "Copy a fresh pairing code from Add device on your computer, then try pasting again."
                    }) {
                        Icon(Icons.Outlined.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Paste code")
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
        }
    }
}
