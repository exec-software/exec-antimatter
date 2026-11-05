package co.antimatter.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.InferenceModel
import co.antimatter.app.domain.RemoteWorkspace
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClaySurfaceAlt
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle

@Composable
fun ChatComposer(
    text: String,
    accessMode: AccessMode,
    model: InferenceModel?,
    workspace: RemoteWorkspace?,
    isStreaming: Boolean,
    canSend: Boolean,
    canSteer: Boolean,
    suggestion: String?,
    onTextChange: (String) -> Unit,
    onAccess: () -> Unit,
    onModel: () -> Unit,
    onAcceptSuggestion: () -> Unit,
    onSend: () -> Unit,
    onSteer: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (suggestion != null) {
            TextButton(onClick = onAcceptSuggestion, modifier = Modifier.fillMaxWidth().widthIn(max = 768.dp)) {
                Column(Modifier.fillMaxWidth()) {
                    Text("Suggested follow-up · Tap to edit", color = ClayTextSubtle, style = MaterialTheme.typography.labelSmall)
                    Text(suggestion, color = ClayTextMuted, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Surface(
            color = ClaySurface,
            contentColor = ClayText,
            shape = MaterialTheme.shapes.large,
            border = BorderStroke(1.dp, ClayBorder),
            shadowElevation = 0.dp,
            modifier = Modifier.fillMaxWidth().widthIn(max = 768.dp),
        ) {
            Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                TextField(
                    value = text,
                    onValueChange = onTextChange,
                    placeholder = {
                        Text(
                            if (workspace == null) "Connect a workspace to start" else "Message Antimatter",
                            color = ClayTextSubtle,
                        )
                    },
                    minLines = 1,
                    maxLines = 6,
                    textStyle = MaterialTheme.typography.bodyLarge,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        focusedTextColor = ClayText,
                        unfocusedTextColor = ClayText,
                        cursorColor = ClayPrimary,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    ),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp, max = 200.dp),
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    TextButton(onClick = onAccess) {
                        Text(accessMode.label, color = ClayTextMuted, style = MaterialTheme.typography.labelMedium)
                        Spacer(Modifier.width(2.dp))
                        Icon(Icons.Outlined.ExpandMore, contentDescription = null, tint = ClayTextSubtle, modifier = Modifier.size(16.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = onModel, modifier = Modifier.weight(0.58f, fill = false)) {
                        Text(
                            text = model?.name ?: "Choose model",
                            color = if (model == null) ClayPrimary else ClayTextMuted,
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (isStreaming) {
                        Surface(
                            shape = CircleShape,
                            color = if (canSteer) ClayPrimary else ClaySurfaceAlt,
                            contentColor = if (canSteer) Color.Black else ClayTextSubtle,
                        ) {
                            IconButton(
                                onClick = onSteer,
                                enabled = canSteer,
                                modifier = Modifier.size(48.dp),
                            ) {
                                Icon(
                                    Icons.AutoMirrored.Filled.Send,
                                    contentDescription = "Steer active response",
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                        Spacer(Modifier.width(4.dp))
                    }
                    Surface(
                        shape = CircleShape,
                        color = when {
                            isStreaming -> MaterialTheme.colorScheme.error
                            canSend -> ClayPrimary
                            else -> ClaySurfaceAlt
                        },
                        contentColor = if (canSend || isStreaming) Color.Black else ClayTextSubtle,
                    ) {
                        IconButton(
                            onClick = if (isStreaming) onStop else onSend,
                            enabled = if (isStreaming) workspace?.phase == ConnectionPhase.ONLINE else canSend,
                            modifier = Modifier.size(48.dp),
                        ) {
                            Icon(
                                if (isStreaming) Icons.Outlined.StopCircle else Icons.AutoMirrored.Filled.Send,
                                contentDescription = if (isStreaming) "Stop response" else "Send message",
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
        if (workspace?.phase != ConnectionPhase.ONLINE) {
            Text(
                text = workspace?.detail ?: "No remote workspace connected",
                color = ClayTextSubtle,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(top = 6.dp),
            )
        } else if (workspace.isPreview) {
            Text(
                text = "UI preview — messages do not leave this device",
                color = ClayTextSubtle,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}
