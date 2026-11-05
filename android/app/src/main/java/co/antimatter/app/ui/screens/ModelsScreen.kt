package co.antimatter.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.InferenceModel
import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.ui.components.AtomMark
import co.antimatter.app.ui.theme.ClayAccent
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClayRaised
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClaySurfaceAlt
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle

@androidx.compose.material3.ExperimentalMaterial3Api
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ModelsScreen(
    state: AntimatterUiState,
    selectionMode: Boolean,
    onOpenDrawer: () -> Unit,
    onBack: () -> Unit,
    onSelectModel: (ModelKey) -> Unit,
    onWorkspaces: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var query by remember { mutableStateOf("") }
    val catalogWorkspaceId = if (selectionMode) {
        state.activeConversation?.hostId ?: state.activeConversation?.workspaceId ?: state.activeWorkspaceId
    } else state.activeWorkspaceId
    val catalogWorkspace = state.workspaces.firstOrNull { it.id == catalogWorkspaceId }
    val models = remember(state.models, catalogWorkspaceId, query) {
        state.models.filter { model ->
            model.workspaceId == catalogWorkspaceId && (
                query.isBlank() || listOf(model.name, model.key.modelId, model.providerName, model.architecture.orEmpty())
                    .any { it.contains(query.trim(), ignoreCase = true) }
                )
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(if (selectionMode) "Choose a model" else "Models", color = ClayText)
                    if (selectionMode) {
                        Text("For this conversation", color = ClayTextSubtle, style = MaterialTheme.typography.labelMedium)
                    }
                }
            },
            navigationIcon = {
                IconButton(onClick = if (selectionMode) onBack else onOpenDrawer) {
                    Icon(
                        if (selectionMode) Icons.AutoMirrored.Outlined.ArrowBack else Icons.Outlined.Menu,
                        contentDescription = if (selectionMode) "Back to chat" else "Open navigation",
                        tint = ClayTextMuted,
                    )
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = ClaySurface),
        )

        Text(
            "Models are provided by your computer. Add providers, API keys, and downloads in desktop Models.",
            color = ClayTextMuted, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
        if (catalogWorkspace?.phase != ConnectionPhase.ONLINE) {
            Button(onClick = onWorkspaces, modifier = Modifier.padding(horizontal = 16.dp)) {
                Text(if (catalogWorkspace == null) "Pair a computer" else "Reconnect to ${catalogWorkspace.name}")
            }
        }
            TextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search models", color = ClayTextSubtle) },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = ClayTextSubtle) },
                singleLine = true,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = ClaySurfaceAlt,
                    unfocusedContainerColor = ClaySurfaceAlt,
                    focusedTextColor = ClayText,
                    unfocusedTextColor = ClayText,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            )

            if (models.isEmpty()) {
                EmptyModels(
                    title = if (catalogWorkspace == null) "Connect a workspace" else "No models found",
                    detail = if (catalogWorkspace == null) {
                        "The mobile client reads model catalogs from an Antimatter host."
                    } else {
                        "Try another search or refresh the source on the host."
                    },
                    modifier = Modifier.weight(1f),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(models, key = { "${it.key.providerId}:${it.key.modelId}" }) { model ->
                        val selected = state.activeModel == model
                        ModelCard(
                            model = model,
                            selected = selected,
                            enabled = !state.isStreaming && !selected &&
                                catalogWorkspace?.phase == ConnectionPhase.ONLINE &&
                                WorkspaceCapability.CHAT in catalogWorkspace.capabilities &&
                                state.activeConversationKey !in state.pendingThreadChanges,
                            onSelect = { onSelectModel(model.key) },
                        )
                    }
                }
            }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ModelCard(model: InferenceModel, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    Surface(
        color = ClayRaised,
        contentColor = ClayText,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, if (selected) ClayPrimary else ClayBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(model.name, style = MaterialTheme.typography.titleMedium, color = ClayText)
                    Text(
                        model.key.modelId,
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (selected) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Check, contentDescription = null, tint = ClayPrimary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Selected", color = ClayPrimary, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(model.providerName, color = ClayTextMuted, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(10.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ModelChip(if (model.localToWorkspace) "Workspace local" else "Remote")
                model.architecture?.let { ModelChip(it) }
                model.quantization?.let { ModelChip(it) }
                model.contextWindow?.let { ModelChip(formatContext(it)) }
                model.supportsVision?.let { ModelChip(if (it) "Vision" else "Text only") }
            }
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = onSelect,
                enabled = enabled,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (selected) ClaySurfaceAlt else ClayPrimary,
                    contentColor = if (selected) ClayTextMuted else Color.Black,
                    disabledContainerColor = ClaySurfaceAlt,
                    disabledContentColor = ClayTextMuted,
                ),
                modifier = Modifier.align(Alignment.End),
            ) {
                Text(if (selected) "Current model" else "Use model")
            }
        }
    }
}

@Composable
private fun ModelChip(label: String) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = ClaySurfaceAlt,
        contentColor = ClayTextMuted,
        border = BorderStroke(1.dp, ClayBorder),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
        )
    }
}

@Composable
private fun EmptyModels(title: String, detail: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        AtomMark(Modifier.size(52.dp))
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, color = ClayText)
        Spacer(Modifier.height(6.dp))
        Text(detail, style = MaterialTheme.typography.bodyMedium, color = ClayTextMuted)
    }
}

private fun formatContext(tokens: Int): String = when {
    tokens >= 1_000_000 -> "${tokens / 1_000_000}M context"
    tokens >= 1_000 -> "${tokens / 1_000}K context"
    else -> "$tokens context"
}
