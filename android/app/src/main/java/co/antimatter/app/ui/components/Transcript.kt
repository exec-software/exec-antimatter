package co.antimatter.app.ui.components

import androidx.compose.animation.animateContentSize
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Pending
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
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
import co.antimatter.app.domain.ChatMessage
import co.antimatter.app.domain.ActiveTurn
import co.antimatter.app.domain.inferenceStatus
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.MessageRole
import co.antimatter.app.domain.PreviewKind
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.domain.ToolActivity
import co.antimatter.app.domain.ToolStatus
import co.antimatter.app.domain.TranscriptPart
import co.antimatter.app.domain.buildTranscriptParts
import co.antimatter.app.ui.theme.ClayAccent
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayError
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClaySurfaceAlt
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted
import co.antimatter.app.ui.theme.ClayTextSubtle
import co.antimatter.app.ui.theme.ClayWarning

@Composable
fun Transcript(
    conversation: Conversation?,
    isStreaming: Boolean,
    onResolveApproval: (ToolActivity, Boolean) -> Unit,
    onOpenPreview: (PreviewRef) -> Unit,
    modifier: Modifier = Modifier,
    activeTurn: ActiveTurn? = null,
) {
    val messages = conversation?.messages.orEmpty()
    val listState = rememberLazyListState()

    // Persistent auto-scroll flag: starts pinned, unpins when user scrolls up,
    // re-pins when they scroll back to the bottom.
    var autoScroll by remember { mutableStateOf(true) }

    val nearBottom by remember(listState) {
        derivedStateOf {
            val layout = listState.layoutInfo
            val lastVisible = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
            layout.totalItemsCount == 0 || lastVisible >= layout.totalItemsCount - 2
        }
    }

    // Update the persistent flag whenever the reactive nearBottom changes.
    LaunchedEffect(nearBottom) {
        if (nearBottom && !autoScroll) {
            autoScroll = true
        } else if (!nearBottom && autoScroll) {
            autoScroll = false
        }
    }

    val lastMessage = messages.lastOrNull()
    val updateKey = lastMessage?.let { message ->
        listOf(message.id, message.content.hashCode(), message.tools.hashCode(), message.failed).hashCode()
    }

    LaunchedEffect(conversation?.id, messages.size, updateKey, isStreaming, autoScroll) {
        if (autoScroll && messages.isNotEmpty()) {
            val target = messages.lastIndex + if (isStreaming) 1 else 0
            listState.animateScrollToItem(target)
        }
    }

    if (messages.isEmpty()) {
        EmptyConversation(modifier)
        return
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 16.dp,
            end = 16.dp,
            top = 20.dp,
            bottom = 20.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        items(messages, key = { it.id }) { message ->
            MessageItem(
                message = message,
                onResolveApproval = onResolveApproval,
                onOpenPreview = onOpenPreview,
                modifier = Modifier.fillMaxWidth().widthIn(max = 768.dp),
            )
        }
        if (isStreaming) {
            item(key = "streaming") {
                val status = inferenceStatus(activeTurn)
                Row(
                    modifier = Modifier.fillMaxWidth().widthIn(max = 768.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AtomMark(Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(status.label, color = ClayAccent, style = MaterialTheme.typography.bodyMedium)
                        status.detail?.let { detail ->
                            Text(detail, color = ClayTextMuted, style = MaterialTheme.typography.bodySmall)
                        }
                        status.progress?.let { progress ->
                            LinearProgressIndicator(
                                progress = { progress }, color = ClayAccent, trackColor = ClaySurfaceAlt,
                                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyConversation(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            AtomMark(Modifier.size(64.dp))
            Spacer(Modifier.height(20.dp))
            Text("What are we building?", style = MaterialTheme.typography.titleLarge, color = ClayText)
            Spacer(Modifier.height(8.dp))
            Text(
                "Start a conversation in a connected workspace.",
                style = MaterialTheme.typography.bodyMedium,
                color = ClayTextMuted,
            )
        }
    }
}

@Composable
private fun MessageItem(
    message: ChatMessage,
    onResolveApproval: (ToolActivity, Boolean) -> Unit,
    onOpenPreview: (PreviewRef) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (message.role) {
        MessageRole.USER -> Row(modifier, horizontalArrangement = Arrangement.End) {
            Surface(
                color = ClaySurfaceAlt,
                contentColor = ClayText,
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth(0.86f).widthIn(max = 640.dp),
            ) {
                SelectionContainer {
                    Text(
                        message.content,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                    )
                }
            }
        }

        MessageRole.ASSISTANT -> Column(modifier) {
            if (message.sourceName != null) {
                Text(
                    text = message.sourceName,
                    color = ClayTextSubtle,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            val parts = remember(message.content, message.tools) {
                buildTranscriptParts(message.content, message.tools)
            }
            parts.forEach { part ->
                when (part) {
                    is TranscriptPart.Text -> SelectionContainer {
                        Text(
                            text = part.text,
                            color = if (message.failed) ClayError else ClayText,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }

                    is TranscriptPart.Tools -> ToolGroup(part, onResolveApproval, onOpenPreview)
                }
                Spacer(Modifier.height(10.dp))
            }
        }

        MessageRole.SYSTEM -> Text(
            message.content,
            color = ClayTextSubtle,
            style = MaterialTheme.typography.bodyMedium,
            modifier = modifier.padding(horizontal = 20.dp),
        )
    }
}

@Composable
private fun ToolGroup(
    part: TranscriptPart.Tools,
    onResolveApproval: (ToolActivity, Boolean) -> Unit,
    onOpenPreview: (PreviewRef) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (part.legacy) {
            Text(
                "Earlier tool position was not recorded",
                color = ClayTextSubtle,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        part.tools.forEach { activity -> ToolActivityRow(activity, onResolveApproval, onOpenPreview) }
    }
}

@Composable
private fun ToolActivityRow(
    activity: ToolActivity,
    onResolveApproval: (ToolActivity, Boolean) -> Unit,
    onOpenPreview: (PreviewRef) -> Unit,
) {
    var expanded by remember(activity.activityId, activity.callId) { mutableStateOf(activity.awaitingApproval) }
    Surface(
        color = if (activity.awaitingApproval) ClaySurfaceAlt else Color.Transparent,
        contentColor = ClayText,
        shape = MaterialTheme.shapes.small,
        border = if (activity.awaitingApproval) BorderStroke(1.dp, ClayPrimary) else null,
        modifier = Modifier.fillMaxWidth().animateContentSize(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { expanded = !expanded },
            ) {
                ToolStatusIcon(activity.status)
                Spacer(Modifier.width(8.dp))
                Text(
                    activity.summary,
                    color = ClayText,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = if (expanded) 3 else 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    if (expanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                    contentDescription = if (expanded) "Collapse tool details" else "Expand tool details",
                    tint = ClayTextSubtle,
                    modifier = Modifier.size(20.dp),
                )
            }
            if (expanded) {
                HorizontalDivider(color = ClayBorder, modifier = Modifier.padding(vertical = 9.dp))
                Text("Arguments", color = ClayTextSubtle, style = MaterialTheme.typography.labelMedium)
                Text(
                    activity.argumentsPreview.ifBlank { "No arguments" },
                    color = ClayTextMuted,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.padding(top = 3.dp),
                )
                activity.resultPreview?.let { result ->
                    Spacer(Modifier.height(9.dp))
                    Text("Result", color = ClayTextSubtle, style = MaterialTheme.typography.labelMedium)
                    Text(
                        result,
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.padding(top = 3.dp),
                    )
                }
                if (activity.awaitingApproval) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        activity.approvalReason ?: "This action needs your approval before the host may continue.",
                        color = ClayTextMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    activity.approvalDetails?.let { details ->
                        Text(
                            details,
                            color = ClayText,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TextButton(onClick = { onResolveApproval(activity, false) }) {
                            Text("Decline", color = ClayTextMuted)
                        }
                        Spacer(Modifier.width(8.dp))
                        Button(
                            onClick = { onResolveApproval(activity, true) },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = ClayPrimary,
                                contentColor = Color.Black,
                            ),
                        ) {
                            Text("Allow once")
                        }
                    }
                }
                activity.preview?.let { preview ->
                    Spacer(Modifier.height(10.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .clickable { onOpenPreview(preview) },
                    ) {
                        Icon(
                            if (preview is PreviewRef.Asset && preview.kind == PreviewKind.IMAGE) {
                                Icons.Outlined.Image
                            } else {
                                Icons.Outlined.Language
                            },
                            contentDescription = null,
                            tint = ClayAccent,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(7.dp))
                        Text(preview.title, color = ClayAccent, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolStatusIcon(status: ToolStatus) {
    val (icon, color) = when (status) {
        ToolStatus.PENDING -> Icons.Outlined.Pending to ClayTextSubtle
        ToolStatus.RUNNING -> Icons.Outlined.HourglassTop to ClayAccent
        ToolStatus.DONE -> Icons.Outlined.CheckCircle to ClayAccent
        ToolStatus.FAILED -> Icons.Outlined.ErrorOutline to ClayError
        ToolStatus.DENIED -> Icons.Outlined.Block to ClayWarning
    }
    Icon(icon, contentDescription = status.name.lowercase(), tint = color, modifier = Modifier.size(18.dp))
}
