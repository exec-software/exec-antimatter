package co.antimatter.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import co.antimatter.app.data.DraftStore
import co.antimatter.app.BuildConfig
import co.antimatter.app.domain.AccessMode
import co.antimatter.app.domain.ActiveTurn
import co.antimatter.app.domain.AntimatterUiState
import co.antimatter.app.domain.AppDestination
import co.antimatter.app.domain.ChatMessage
import co.antimatter.app.domain.ConnectionPhase
import co.antimatter.app.domain.Conversation
import co.antimatter.app.domain.MessageRole
import co.antimatter.app.domain.ModelKey
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.domain.RemoteHost
import co.antimatter.app.domain.ThreadKey
import co.antimatter.app.domain.ToolActivity
import co.antimatter.app.domain.ToolStatus
import co.antimatter.app.domain.WorkspaceCapability
import co.antimatter.app.domain.newConversation
import co.antimatter.app.domain.FollowUpSuggestion
import co.antimatter.app.domain.followUpSuggestion
import co.antimatter.app.domain.latestInference
import co.antimatter.app.remote.ApprovalDecision
import co.antimatter.app.remote.CursorDisposition
import co.antimatter.app.remote.CommandReceipt
import co.antimatter.app.remote.CommandDisposition
import co.antimatter.app.remote.EventCursor
import co.antimatter.app.remote.PairingOffer
import co.antimatter.app.remote.PairingRequest
import co.antimatter.app.remote.RemoteWorkspaceException
import co.antimatter.app.remote.RemoteWorkspaceGateway
import co.antimatter.app.remote.StoredHostCredential
import co.antimatter.app.remote.WorkspaceCommand
import co.antimatter.app.remote.WorkspaceCredentialStore
import co.antimatter.app.remote.WorkspaceEvent
import co.antimatter.app.remote.WorkspaceEventEnvelope
import co.antimatter.app.remote.WorkspaceSnapshot
import co.antimatter.app.remote.WorkspaceStreamFrame
import co.antimatter.app.remote.classifyCursor
import co.antimatter.app.remote.shouldApplyNetworkSnapshot
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class AntimatterViewModel(
    initialState: AntimatterUiState = disconnectedState(),
    private val gateway: RemoteWorkspaceGateway? = null,
    private val credentialStore: WorkspaceCredentialStore? = null,
    private val deviceName: String = "Android device",
    private val clientVersion: String = BuildConfig.VERSION_NAME,
    private val storageDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val draftStore: DraftStore? = null,
) : ViewModel() {
    private val _state = MutableStateFlow(initialState)
    val state: StateFlow<AntimatterUiState> = _state.asStateFlow()
    private val previewTurns = mutableMapOf<ThreadKey, Job>()
    private val eventJobs = mutableMapOf<String, Job>()
    private val eventCursors = mutableMapOf<String, EventCursor>()
    private val connectionJobs = mutableMapOf<String, Job>()
    private val connectionGenerations = mutableMapOf<String, Long>()
    private var selectionGeneration = 0L
    private val pairingAttempts = PairingAttemptGate()
    private val draftStorageMutex = Mutex()
    private val pairedHostIds = mutableSetOf<String>()
    private val draftVersions = mutableMapOf<ThreadKey, Long>()
    private val draftHostGenerations = mutableMapOf<String, Long>()
    private val forgettingHosts = mutableSetOf<String>()
    private val pendingSteers = mutableSetOf<Pair<ThreadKey, String>>()
    private val pendingStops = mutableSetOf<Pair<ThreadKey, String>>()
    private class LocalStart(val requestId: String, val generation: Long) {
        var acceptedVersion: Long? = null
        var confirmed = false
        val ready = CompletableDeferred<Unit>()
    }
    private val localStarts = mutableMapOf<ThreadKey, LocalStart>()
    private var acceptedStartVersion = 0L
    private val turnRecoveryJobs = mutableMapOf<ThreadKey, Job>()

    init {
        if (gateway != null && credentialStore != null) restorePairedHosts()
    }

    fun navigate(destination: AppDestination) {
        _state.update { it.copy(destination = destination, modelPickerOpen = false, openPreview = null) }
    }

    fun updateSearch(search: String) {
        _state.update { it.copy(search = search) }
    }

    fun updateDraft(text: String) {
        val key = _state.value.activeConversationKey ?: return
        draftVersions[key] = draftVersions[key].orZero() + 1
        _state.update { state ->
            val thread = state.activeConversationKey ?: return@update state
            state.copy(drafts = state.drafts + (thread to state.draft.copy(text = text)))
        }
        persistDraft(key, text)
    }

    fun acceptFollowUpSuggestion(suggestion: FollowUpSuggestion) {
        if (_state.value.followUpSuggestion() != suggestion) return
        draftVersions[suggestion.thread] = draftVersions[suggestion.thread].orZero() + 1
        _state.update { state ->
            if (state.followUpSuggestion() != suggestion) return@update state
            state.copy(drafts = state.drafts + (suggestion.thread to state.draft.copy(text = suggestion.text)))
        }
        persistDraft(suggestion.thread, suggestion.text)
    }

    private fun persistDraft(key: ThreadKey, text: String) {
        val store = draftStore ?: return
        val hostId = key.hostId ?: return
        val generation = draftHostGenerations[hostId].orZero()
        val version = draftVersions[key].orZero()
        viewModelScope.launch {
            draftStorageMutex.withLock {
                if (hostId !in pairedHostIds || hostId in forgettingHosts || draftHostGenerations[hostId].orZero() != generation ||
                    draftVersions[key].orZero() != version) return@withLock
                withContext(storageDispatcher) { store.saveText(key, text) }.exceptionOrNull()?.let {
                    notify(it.message ?: "Your unsent draft could not be saved. Keep this app open until you can send it.")
                }
            }
        }
    }

    private suspend fun restoreDrafts(hostId: String) {
        val store = draftStore ?: return
        val generation = connectionGenerations[hostId].orZero()
        val versions = draftVersions.toMap()
        val restored = draftStorageMutex.withLock {
            withContext(storageDispatcher) { store.loadHost(hostId) }
        }.getOrElse {
            notify("Saved drafts could not be unlocked. Your conversations are still on the computer.")
            return
        }
        if (hostId !in pairedHostIds || connectionGenerations[hostId].orZero() != generation) return
        _state.update { state ->
            val eligible = restored.filter { (key, _) ->
                key.hostId == hostId && draftVersions[key].orZero() == versions[key].orZero() && key !in state.drafts
            }.mapValues { co.antimatter.app.domain.ComposerDraft(it.value) }
            state.copy(drafts = state.drafts + eligible)
        }
    }

    private fun clearAcceptedDraft(key: ThreadKey) {
        // New typing while the POST was in flight belongs to the next message, not this one.
        if (!_state.value.drafts[key]?.text.isNullOrEmpty()) return
        draftVersions[key] = draftVersions[key].orZero() + 1
        persistDraft(key, "")
    }

    fun newChat() {
        val state = _state.value
        val host = state.workspaces.firstOrNull { it.id == state.activeWorkspaceId }
        if (host?.isPreview == true || (gateway == null && host != null)) {
            addLocalConversation(state.activeWorkspaceId)
            return
        }
        if (host == null) {
            _state.update { it.copy(destination = AppDestination.WORKSPACES, workspaceEditorOpen = true) }
            return
        }
        if (host.phase != ConnectionPhase.ONLINE) {
            _state.update { it.copy(destination = AppDestination.WORKSPACES) }
            notify("Connect to ${host.name} before starting a chat.")
            return
        }
        val project = state.projects.firstOrNull { it.hostId == host.id && it.id == state.activeProjectId }
            ?: state.projects.firstOrNull { it.hostId == host.id && it.isDefault }
            ?: state.projects.firstOrNull { it.hostId == host.id }
        if (project == null) {
            notify("This host has no available project.")
            return
        }
        if (WorkspaceCapability.CHAT !in host.capabilities || WorkspaceCapability.CHAT !in project.capabilities) {
            notify("This project does not allow chat from this device. Check its access on your computer.")
            return
        }
        val model = state.models.firstOrNull { it.workspaceId == host.id }?.key
        createRemoteConversation(host.id, project.id, model)
    }

    private fun createRemoteConversation(hostId: String, projectId: String, model: ModelKey?) {
        val remote = gateway ?: return
        val clientThreadId = UUID.randomUUID().toString()
        val generation = connectionGenerations[hostId] ?: 0L
        val selectedAt = selectionGeneration
        viewModelScope.launch {
            val receipt = sendRemoteCommand(remote,
                WorkspaceCommand.CreateThread(
                    hostId = hostId,
                    projectId = projectId,
                    commandId = UUID.randomUUID().toString(),
                    clientThreadId = clientThreadId,
                    model = model,
                ),
            ).getOrElse { error ->
                notify(error.message ?: "The host could not create a conversation.")
                return@launch
            }
            val threadId = receipt.threadId
            if (connectionGenerations[hostId].orZero() != generation) return@launch
            if (threadId == null || receipt.clientThreadId != clientThreadId) {
                notify("The host returned an invalid conversation receipt. Refresh the workspace before retrying.")
                refreshHost(hostId).getOrNull()
                return@launch
            }
            val requestedAt = eventCursors[hostId]
            val startsAcceptedAt = acceptedStartVersion
            val snapshot = remote.snapshot(hostId, threadId).getOrElse { error ->
                notify(error.message ?: "The host created the conversation, but its snapshot could not be loaded.")
                refreshHost(hostId).getOrNull()
                return@launch
            }
            if (!applySnapshot(snapshot, makeActive = selectionGeneration == selectedAt, requestedAt = requestedAt, generation = generation, startsAcceptedAt = startsAcceptedAt)) {
                if (connectionGenerations[hostId].orZero() == generation) {
                    refreshHost(hostId, threadId, makeActive = selectionGeneration == selectedAt).getOrNull()
                }
            }
        }
    }

    private fun addLocalConversation(hostId: String?) {
        _state.update { state ->
            val project = state.projects.firstOrNull { it.hostId == hostId && it.id == state.activeProjectId }
            val conversation = newConversation(
                workspaceId = hostId,
                model = state.models.firstOrNull { it.workspaceId == hostId }?.key,
                project = project?.name ?: "Inbox",
                projectId = project?.id,
            )
            state.copy(
                destination = AppDestination.CHAT,
                conversations = listOf(conversation) + state.conversations,
                activeConversationKey = conversation.threadKey,
            )
        }
    }

    fun selectConversation(key: ThreadKey) {
        val selected = _state.value.conversations.firstOrNull { it.threadKey == key } ?: return
        selectionGeneration++
        _state.update { state ->
            state.copy(
                destination = AppDestination.CHAT,
                activeConversationKey = key,
                activeWorkspaceId = selected.hostId ?: selected.workspaceId ?: state.activeWorkspaceId,
                activeProjectId = selected.projectId ?: state.activeProjectId,
            )
        }
        val hostId = selected.hostId ?: selected.workspaceId
        val projectId = selected.projectId
        if (gateway != null && hostId != null && projectId != null && !(_state.value.activeWorkspace?.isPreview ?: false)) {
            loadThread(hostId, projectId, selected.id, quiet = true)
        }
    }

    fun togglePinned(key: ThreadKey) {
        changeConversation(key) { conversation, hostId, projectId, revision ->
            WorkspaceCommand.SetThreadPinned(hostId, projectId, UUID.randomUUID().toString(),
                conversation.id, revision, !conversation.pinned)
        }
    }

    fun renameConversation(key: ThreadKey, title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty() || trimmed.length > 240) {
            notify("Use a conversation name between 1 and 240 characters.")
            return
        }
        changeConversation(key) { conversation, hostId, projectId, revision ->
            WorkspaceCommand.RenameThread(hostId, projectId, UUID.randomUUID().toString(),
                conversation.id, revision, trimmed)
        }
    }

    /** The UI must confirm destructive intent before invoking this command. */
    fun deleteConversation(key: ThreadKey) {
        changeConversation(key) { conversation, hostId, projectId, revision ->
            WorkspaceCommand.DeleteThread(hostId, projectId, UUID.randomUUID().toString(), conversation.id, revision)
        }
    }

    private fun changeConversation(
        key: ThreadKey,
        command: (Conversation, String, String, String) -> WorkspaceCommand,
    ) {
        val current = _state.value
        val conversation = current.conversations.firstOrNull { it.threadKey == key } ?: return
        val hostId = conversation.hostId ?: conversation.workspaceId ?: return
        val host = current.workspaces.firstOrNull { it.id == hostId }
        val project = current.projects.firstOrNull { it.hostId == hostId && it.id == conversation.projectId }
        if (key in current.pendingThreadChanges) return
        if (key in current.activeTurns) {
            notify("Stop the active response before changing this conversation.")
            return
        }
        if (host?.phase != ConnectionPhase.ONLINE || WorkspaceCapability.CHAT !in host.capabilities ||
            WorkspaceCapability.CHAT !in project?.capabilities.orEmpty()) {
            notify("Reconnect to a computer with chat access before changing this conversation.")
            return
        }
        val remote = gateway ?: run { notify("Conversation changes need a connected desktop."); return }
        val revision = conversation.revision
        if (revision == null) {
            notify("Refresh this conversation before changing it.")
            loadThread(hostId, project?.id, conversation.id, quiet = false)
            return
        }
        val generation = connectionGenerations[hostId].orZero()
        val request = command(conversation, hostId, requireNotNull(project).id, revision)
        _state.update { it.copy(pendingThreadChanges = it.pendingThreadChanges + key) }
        viewModelScope.launch {
            try {
                val result = sendRemoteCommand(remote, request)
                if (connectionGenerations[hostId].orZero() != generation) return@launch
                result.exceptionOrNull()?.let {
                    notify(it.message ?: "The computer could not update this conversation. Refresh and retry.")
                }
                // Acceptance is not completion. Only host snapshots/events change the local title,
                // pin or list so a late dispatch failure never looks like a successful deletion.
                refreshHost(hostId, if (request is WorkspaceCommand.DeleteThread) null else conversation.id).getOrNull()
            } finally {
                _state.update { it.copy(pendingThreadChanges = it.pendingThreadChanges - key) }
            }
        }
    }

    fun showModelPicker(show: Boolean) {
        _state.update { state ->
            state.copy(
                modelPickerOpen = show,
                destination = if (show) AppDestination.MODELS else AppDestination.CHAT,
                activeWorkspaceId = if (show) {
                    state.activeConversation?.hostId ?: state.activeConversation?.workspaceId ?: state.activeWorkspaceId
                } else state.activeWorkspaceId,
            )
        }
    }

    fun selectModel(key: ModelKey) {
        val state = _state.value
        val catalogHostId = if (state.modelPickerOpen) {
            state.activeConversation?.hostId ?: state.activeConversation?.workspaceId ?: state.activeWorkspaceId
        } else state.activeWorkspaceId
        val model = state.models.firstOrNull { it.workspaceId == catalogHostId && it.key == key } ?: return
        val active = state.activeConversation
        if (active?.threadKey in state.pendingThreadChanges) {
            notify("Wait for the conversation change to finish before changing models.")
            return
        }
        if (active != null && state.activeTurns.containsKey(active.threadKey)) {
            notify("Stop the active turn before changing models.")
            return
        }

        val activeHostId = active?.hostId ?: active?.workspaceId
        val remote = gateway
        val targetHost = state.workspaces.firstOrNull { it.id == model.workspaceId }
        if (targetHost == null) {
            notify("The host for this model is no longer available. Refresh your workspaces and try again.")
            return
        }
        if (remote == null || targetHost.isPreview) {
            selectLocalModel(model.workspaceId, key)
            return
        }
        if (targetHost.phase != ConnectionPhase.ONLINE || WorkspaceCapability.CHAT !in targetHost.capabilities) {
            notify("Reconnect to ${targetHost.name} before choosing a model.")
            return
        }

        if (active != null && activeHostId == model.workspaceId) {
            if (!state.canChatInActiveProject) {
                notify("This project does not allow chat from this device.")
                return
            }
            val projectId = active.projectId
            val revision = active.revision
            if (projectId == null || revision == null) {
                notify("Refreshing this conversation before changing its model.")
                loadThread(model.workspaceId, projectId, active.id, quiet = true)
                return
            }
            viewModelScope.launch {
                sendRemoteCommand(remote,
                    WorkspaceCommand.SetThreadModel(
                        hostId = model.workspaceId,
                        projectId = projectId,
                        commandId = UUID.randomUUID().toString(),
                        threadId = active.id,
                        expectedRevision = revision,
                        model = key,
                    ),
                ).getOrElse { error ->
                    notify(error.message ?: "The host could not change this conversation's model.")
                    refreshHost(model.workspaceId, active.id).getOrNull()
                    return@launch
                }
                val refreshed = refreshHost(model.workspaceId, active.id)
                if (refreshed.isFailure) {
                    notify(refreshed.exceptionOrNull()?.message ?: "The model changed, but the conversation could not be refreshed.")
                    return@launch
                }
                _state.update { current ->
                    current.copy(
                        modelPickerOpen = false,
                        destination = if (current.modelPickerOpen) AppDestination.CHAT else current.destination,
                    )
                }
            }
            return
        }

        val project = state.projects.firstOrNull {
            state.activeWorkspaceId == model.workspaceId && it.hostId == model.workspaceId && it.id == state.activeProjectId
        } ?: state.projects.firstOrNull { it.hostId == model.workspaceId && it.isDefault }
            ?: state.projects.firstOrNull { it.hostId == model.workspaceId }
        if (project == null) {
            notify("This host has no available project.")
            return
        }
        if (WorkspaceCapability.CHAT !in project.capabilities) {
            notify("This project does not allow chat from this device.")
            return
        }
        createRemoteConversation(model.workspaceId, project.id, key)
    }

    private fun selectLocalModel(hostId: String, key: ModelKey) {
        _state.update { state ->
            val active = state.activeConversation
            if ((active?.hostId ?: active?.workspaceId) == hostId && active != null) {
                state.copy(
                    modelPickerOpen = false,
                    destination = if (state.modelPickerOpen) AppDestination.CHAT else state.destination,
                    conversations = state.conversations.map {
                        if (it.threadKey == active.threadKey) it.copy(model = key) else it
                    },
                )
            } else {
                val project = state.projects.firstOrNull { it.hostId == hostId && it.isDefault }
                    ?: state.projects.firstOrNull { it.hostId == hostId }
                val conversation = newConversation(
                    workspaceId = hostId,
                    model = key,
                    project = project?.name ?: "Inbox",
                    projectId = project?.id,
                )
                state.copy(
                    modelPickerOpen = false,
                    destination = AppDestination.CHAT,
                    activeWorkspaceId = hostId,
                    activeProjectId = project?.id,
                    activeConversationKey = conversation.threadKey,
                    conversations = listOf(conversation) + state.conversations,
                )
            }
        }
    }

    fun showAccessPicker(show: Boolean) {
        _state.update { it.copy(accessPickerOpen = show) }
    }

    fun selectAccessMode(mode: AccessMode) {
        _state.update { state ->
            val thread = state.activeConversationKey ?: return@update state
            state.copy(
                accessPickerOpen = false,
                conversations = state.conversations.map {
                    if (it.threadKey == thread) it.copy(accessMode = mode) else it
                },
            )
        }
    }

    fun showWorkspaceEditor(show: Boolean) {
        _state.update { it.copy(workspaceEditorOpen = show) }
    }

    /** Accepts a transient scanned-or-pasted code; it is never copied into UI state. */
    fun pairWorkspace(rawPairingCode: String): Boolean {
        val remote = gateway
        if (remote == null) {
            notify("Remote transport is unavailable in this process.")
            return false
        }
        val attemptId = pairingAttempts.tryStart()
        if (attemptId == null) {
            notify("A computer is already being paired. Wait for it to finish before trying another code.")
            return false
        }
        val offer = PairingOffer.parse(rawPairingCode).getOrElse { error ->
            pairingAttempts.finish(attemptId)
            notify(error.message ?: "That pairing code is invalid.")
            return false
        }
        connectionGenerations[offer.hostId] = (connectionGenerations[offer.hostId] ?: 0L) + 1L
        val generation = connectionGenerations.getValue(offer.hostId)
        val selectedAt = ++selectionGeneration
        _state.update { state ->
            val pending = RemoteHost(
                id = offer.hostId,
                name = offer.hostId,
                baseUrl = offer.endpoint.baseUrl,
                phase = ConnectionPhase.CONNECTING,
                detail = "Pairing…",
            )
            state.copy(
                workspaceEditorOpen = false,
                destination = AppDestination.WORKSPACES,
                pairingHostId = offer.hostId,
                activeWorkspaceId = offer.hostId,
                activeConversationKey = null,
                activeProjectId = null,
                workspaces = state.workspaces.filterNot { it.id == offer.hostId } + pending,
            )
        }
        viewModelScope.launch {
            try {
                connectionJobs.remove(offer.hostId)?.cancelAndJoin()
                eventJobs.remove(offer.hostId)?.cancelAndJoin()
                eventCursors.remove(offer.hostId)
                val paired = remote.pair(
                    offer,
                    PairingRequest(
                        deviceName = deviceName.take(80),
                        clientVersion = clientVersion.take(80),
                        requestedCapabilities = WorkspaceCapability.entries.toSet(),
                    ),
                ).getOrElse { error ->
                    markHostError(offer.hostId, error.message ?: "Pairing failed. Show a new code on the computer and try again.", requiresPairing = true)
                    return@launch
                }
                pairedHostIds += paired.host.id
                restoreDrafts(paired.host.id)
                _state.update { current -> current.copy(workspaces = current.workspaces.map {
                    if (it.id == paired.host.id) paired.host.copy(phase = ConnectionPhase.CONNECTING, detail = "Paired. Loading projects…") else it
                }) }
                val requestedAt = eventCursors[paired.host.id]
                val startsAcceptedAt = acceptedStartVersion
                val snapshot = remote.snapshot(paired.host.id).getOrElse { error ->
                    markHostError(paired.host.id, error.message ?: "The paired host could not be loaded.", requiresPairing = needsNewPairing(error))
                    return@launch
                }
                if (!applySnapshot(snapshot, makeActive = selectionGeneration == selectedAt, requestedAt = requestedAt, generation = generation, startsAcceptedAt = startsAcceptedAt)) return@launch
                startEventPolling(snapshot.host.id)
                notify("Paired with ${snapshot.host.name}.")
            } finally {
                pairingAttempts.finish(attemptId)
                _state.update { it.copy(pairingHostId = null) }
            }
        }
        return true
    }

    fun selectWorkspace(id: String) {
        val state = _state.value
        if (state.workspaces.none { it.id == id }) return
        selectionGeneration++
        val existing = state.conversations
            .filter { (it.hostId ?: it.workspaceId) == id && !it.archived }
            .maxByOrNull { it.updatedAtMillis }
        val defaultProject = state.projects.firstOrNull { it.hostId == id && it.isDefault }
            ?: state.projects.firstOrNull { it.hostId == id }
        if (existing == null && (gateway == null || state.workspaces.first { it.id == id }.isPreview)) {
            val conversation = newConversation(
                workspaceId = id,
                model = state.models.firstOrNull { it.workspaceId == id }?.key,
                project = defaultProject?.name ?: "Inbox",
                projectId = defaultProject?.id,
            )
            _state.update {
                it.copy(
                    activeWorkspaceId = id,
                    activeProjectId = defaultProject?.id,
                    activeConversationKey = conversation.threadKey,
                    conversations = listOf(conversation) + it.conversations,
                )
            }
            return
        }
        _state.update {
            it.copy(
                activeWorkspaceId = id,
                activeProjectId = existing?.projectId ?: defaultProject?.id,
                activeConversationKey = existing?.threadKey,
            )
        }
        if (existing != null) selectConversation(existing.threadKey)
    }

    fun selectProject(hostId: String, projectId: String) {
        val state = _state.value
        if (state.projects.none { it.hostId == hostId && it.id == projectId }) return
        selectionGeneration++
        val existing = state.conversations.filter {
            (it.hostId ?: it.workspaceId) == hostId && it.projectId == projectId && !it.archived
        }.maxByOrNull { it.updatedAtMillis }
        _state.update { it.copy(
            activeWorkspaceId = hostId,
            activeProjectId = projectId,
            activeConversationKey = existing?.threadKey,
            destination = AppDestination.CHAT,
        ) }
        existing?.let { selectConversation(it.threadKey) }
    }

    /** Reconcile after Android resumes a sleeping process; never resubmit a chat command. */
    fun resumeConnections() {
        _state.value.workspaces.filter { !it.isPreview && !it.requiresPairing }.forEach {
            reconnectWorkspace(it.id)
        }
    }

    fun reconnectWorkspace(hostId: String) {
        val remote = gateway ?: return
        val store = credentialStore ?: return
        if (connectionJobs[hostId]?.isActive == true || _state.value.pairingHostId == hostId) return
        connectionGenerations[hostId] = (connectionGenerations[hostId] ?: 0L) + 1L
        clearPendingStarts(hostId)
        eventJobs.remove(hostId)?.cancel()
        connectionJobs[hostId] = viewModelScope.launch {
            val stored = withContext(storageDispatcher) { store.load(hostId) }.getOrElse { error ->
                markHostError(hostId, error.message ?: "The saved connection could not be unlocked.", requiresPairing = true)
                return@launch
            }
            if (stored == null) {
                markHostError(hostId, "Show a new QR code on the computer to pair this phone.", requiresPairing = true)
                return@launch
            }
            val current = _state.value
            val hasSelection = current.activeWorkspaceId == hostId &&
                (current.activeProjectId != null || current.activeConversationKey != null)
            restoreHost(remote, stored, makeActive = current.activeWorkspaceId == hostId && !hasSelection)
        }
    }

    fun forgetWorkspace(hostId: String) {
        val store = credentialStore ?: return
        if (_state.value.pairingHostId == hostId || hostId in forgettingHosts) return
        forgettingHosts += hostId
        draftHostGenerations[hostId] = draftHostGenerations[hostId].orZero() + 1
        connectionGenerations[hostId] = (connectionGenerations[hostId] ?: 0L) + 1L
        clearPendingStarts(hostId)
        connectionJobs.remove(hostId)?.cancel()
        eventJobs.remove(hostId)?.cancel()
        connectionJobs[hostId] = viewModelScope.launch {
            try {
                draftStore?.let { drafts ->
                    draftStorageMutex.withLock {
                        withContext(storageDispatcher) { drafts.removeHost(hostId) }
                    }.getOrElse { error ->
                        markHostError(hostId, error.message ?: "Saved drafts could not be removed. Retry before forgetting this computer.", connectionNotice = false)
                        return@launch
                    }
                }
                withContext(storageDispatcher) { store.remove(hostId) }.getOrElse { error ->
                    // Polling has stopped, so this retained connection must offer Retry instead of
                    // looking online while no longer receiving replies or tool events.
                    markHostError(hostId, error.message ?: "The saved connection could not be removed. Retry the connection to continue.", connectionNotice = false)
                    return@launch
                }
                pairedHostIds -= hostId
                draftVersions.keys.removeAll { it.hostId == hostId }
                eventCursors.remove(hostId)
                _state.update { current ->
                    val active = current.activeWorkspaceId == hostId || current.activeConversationKey?.hostId == hostId
                    current.copy(
                        workspaces = current.workspaces.filterNot { it.id == hostId },
                        projects = current.projects.filterNot { it.hostId == hostId },
                        models = current.models.filterNot { it.workspaceId == hostId },
                        conversations = current.conversations.filterNot { it.threadKey.hostId == hostId },
                        drafts = current.drafts.filterKeys { it.hostId != hostId },
                        pendingThreadChanges = current.pendingThreadChanges.filterNot { it.hostId == hostId }.toSet(),
                        activeTurns = current.activeTurns.filterKeys { it.hostId != hostId },
                        activeWorkspaceId = if (active) null else current.activeWorkspaceId,
                        activeProjectId = if (active) null else current.activeProjectId,
                        activeConversationKey = if (active) null else current.activeConversationKey,
                        destination = if (active) AppDestination.WORKSPACES else current.destination,
                        notice = "Connection removed from this phone. You can also revoke the device in desktop Settings.",
                        connectionNoticeHostId = null,
                    )
                }
                // Removing an unreachable computer must complete locally without waiting for HTTP.
                gateway?.disconnect(hostId)
            } finally {
                forgettingHosts -= hostId
                // If forgetting failed after clearing the draft file, retain the still-connected
                // host's current text so the recovery path does not silently lose it on restart.
                if (hostId in pairedHostIds) {
                    _state.value.drafts.filterKeys { it.hostId == hostId }.forEach { (key, draft) ->
                        persistDraft(key, draft.text)
                    }
                }
            }
        }
    }

    fun resolveApproval(activity: ToolActivity, approved: Boolean) {
        val approvalId = activity.approvalId
        if (!activity.awaitingApproval || approvalId.isNullOrBlank()) {
            notify("This approval is no longer active.")
            return
        }
        val state = _state.value
        val conversation = state.activeConversation ?: return
        val host = state.activeWorkspace ?: return
        if (gateway == null || host.isPreview || conversation.projectId == null) {
            settleApprovalLocally(conversation.threadKey, activity, approved)
            return
        }
        viewModelScope.launch {
            sendRemoteCommand(gateway,
                WorkspaceCommand.ResolveApproval(
                    host.id,
                    conversation.projectId,
                    UUID.randomUUID().toString(),
                    conversation.id,
                    activity.requestId,
                    approvalId,
                    if (approved) ApprovalDecision.ALLOW_ONCE else ApprovalDecision.DECLINE,
                ),
            ).getOrElse { error ->
                notify(error.message ?: "The approval decision was not delivered.")
                return@launch
            }
            settleApprovalLocally(conversation.threadKey, activity, approved)
        }
    }

    private fun settleApprovalLocally(threadKey: ThreadKey, activity: ToolActivity, approved: Boolean) {
        _state.update { state ->
            state.copy(
                notice = if (approved) "Approval sent. The host still enforces its access ceiling." else "Action declined.",
                connectionNoticeHostId = null,
                conversations = state.conversations.map { conversation ->
                    if (conversation.threadKey != threadKey) return@map conversation
                    conversation.copy(messages = conversation.messages.map { message ->
                        message.copy(tools = message.tools.map { candidate ->
                            if (candidate.approvalId == activity.approvalId && candidate.requestId == activity.requestId) {
                                candidate.copy(
                                    awaitingApproval = false,
                                    status = if (approved) ToolStatus.PENDING else ToolStatus.DENIED,
                                )
                            } else candidate
                        })
                    })
                },
            )
        }
    }

    fun openPreview(preview: PreviewRef) {
        _state.update { it.copy(destination = AppDestination.PREVIEW, openPreview = preview) }
    }

    fun closePreview() {
        _state.update { it.copy(destination = AppDestination.CHAT, openPreview = null) }
    }

    fun dismissNotice(message: String? = _state.value.notice, connectionHostId: String? = _state.value.connectionNoticeHostId) {
        _state.update {
            if (it.notice == message && it.connectionNoticeHostId == connectionHostId) {
                it.copy(notice = null, connectionNoticeHostId = null)
            } else it
        }
    }

    fun notify(message: String) {
        _state.update { it.copy(notice = message, connectionNoticeHostId = null) }
    }

    fun send() {
        val snapshot = _state.value
        if (snapshot.activeTurn != null) {
            notify("A turn is already active in this conversation.")
            return
        }
        if (!snapshot.canSend) {
            notify(
                when {
                    snapshot.activeWorkspace == null -> "Connect a remote workspace before sending."
                    snapshot.activeWorkspace?.phase != ConnectionPhase.ONLINE -> "This workspace is offline."
                    WorkspaceCapability.CHAT !in snapshot.activeWorkspace?.capabilities.orEmpty() -> "This workspace does not offer chat."
                    !snapshot.canChatInActiveProject -> "This project does not allow chat from this device."
                    snapshot.activeConversationKey in snapshot.pendingThreadChanges -> "Wait for the conversation change to finish."
                    snapshot.activeModel == null -> "Choose an available model for this workspace before sending."
                    else -> "Write a message first."
                },
            )
            return
        }

        val conversation = snapshot.activeConversation ?: return
        val threadKey = conversation.threadKey
        val host = snapshot.activeWorkspace ?: return
        val sendGeneration = connectionGenerations[host.id].orZero()
        val text = snapshot.draft.text.trim()
        val now = System.currentTimeMillis()
        val userMessage = ChatMessage(
            id = UUID.randomUUID().toString(),
            role = MessageRole.USER,
            content = text,
            createdAtMillis = now,
            attachments = snapshot.draft.attachments,
        )
        val active = ActiveTurn(
            workspaceId = host.id,
            threadId = conversation.id,
            requestId = UUID.randomUUID().toString(),
            responseMessageId = UUID.randomUUID().toString(),
            projectId = conversation.projectId,
            startedAtMillis = now,
        )
        _state.update { state ->
            state.copy(
                drafts = state.drafts + (threadKey to state.draft.copy(text = "", attachments = emptyList())),
                activeTurns = state.activeTurns + (threadKey to active),
                conversations = state.conversations.map {
                    if (it.threadKey == threadKey) it.copy(
                        title = if (it.messages.isEmpty()) text.take(48) else it.title,
                        updatedAtMillis = now,
                        messages = it.messages + userMessage,
                    ) else it
                },
            )
        }

        if (host.isPreview || gateway == null) {
            answerPreview(conversation, active)
            return
        }
        val projectId = conversation.projectId
        val model = conversation.model
        val revision = conversation.revision
        if (projectId == null || model == null || revision == null) {
            failLocalTurn(threadKey, active, "This conversation is missing remote routing information.")
            return
        }
        val assetIds = userMessage.attachments.mapNotNull { it.assetId }
        if (assetIds.size != userMessage.attachments.size) {
            failLocalTurn(threadKey, active, "One or more attachments have not finished uploading.")
            return
        }
        val localStart = LocalStart(active.requestId, sendGeneration)
        localStarts[threadKey] = localStart
        viewModelScope.launch {
            val sendResult = sendRemoteCommand(gateway,
                WorkspaceCommand.StartTurn(
                    hostId = host.id,
                    projectId = projectId,
                    commandId = UUID.randomUUID().toString(),
                    threadId = conversation.id,
                    requestId = active.requestId,
                    userMessageId = userMessage.id,
                    responseMessageId = active.responseMessageId,
                    expectedRevision = revision,
                    model = model,
                    content = text,
                    attachmentIds = assetIds,
                    accessMode = conversation.accessMode,
                ),
            )
            if (connectionGenerations[host.id].orZero() != sendGeneration) return@launch
            val error = sendResult.exceptionOrNull()
            if (error != null) {
                if (!localStart.confirmed) {
                    confirmLocalStart(threadKey, active.requestId, accepted = false)
                    failLocalTurn(threadKey, active, error.message ?: "The remote turn could not be started.")
                    _state.update { current ->
                        val draft = current.drafts[threadKey]
                        if (draft?.text.isNullOrEmpty() && draft?.attachments.isNullOrEmpty()) {
                            current.copy(drafts = current.drafts + (threadKey to snapshot.draft))
                        } else current
                    }
                }
                refreshHost(host.id).getOrNull()
                return@launch
            }
            localStart.acceptedVersion = ++acceptedStartVersion
            localStart.ready.complete(Unit)
            clearAcceptedDraft(threadKey)
            if (sendResult.getOrThrow().disposition == CommandDisposition.ALREADY_FINISHED) {
                confirmLocalStart(threadKey, active.requestId)
                refreshHost(host.id).getOrNull()
            } else if (!localStart.confirmed) {
                scheduleTurnRecovery(threadKey, active.requestId, sendGeneration)
            }
        }.invokeOnCompletion { localStart.ready.complete(Unit) }
    }

    private fun clearPendingStarts(hostId: String) {
        localStarts.keys.filter { it.hostId == hostId }.toList().forEach { key ->
            localStarts.remove(key)?.ready?.complete(Unit)
        }
        turnRecoveryJobs.keys.filter { it.hostId == hostId }.toList().forEach { key ->
            turnRecoveryJobs.remove(key)?.cancel()
        }
    }

    private fun confirmLocalStart(key: ThreadKey, requestId: String, accepted: Boolean = true) {
        val start = localStarts[key]
        if (start?.requestId == requestId) {
            start.confirmed = accepted
            start.ready.complete(Unit)
            localStarts.remove(key)
            turnRecoveryJobs.remove(key)?.cancel()
            if (accepted) clearAcceptedDraft(key)
        }
    }

    private fun scheduleTurnRecovery(key: ThreadKey, requestId: String, generation: Long) {
        val hostId = key.hostId ?: return
        turnRecoveryJobs.remove(key)?.cancel()
        turnRecoveryJobs[key] = viewModelScope.launch {
            try {
                delay(3_000)
                if (connectionGenerations[hostId].orZero() != generation ||
                    _state.value.activeTurns[key]?.requestId != requestId) return@launch
                // Refresh the current selection: navigating elsewhere is not a failed send.
                refreshHost(hostId).getOrNull()
            } finally {
                if (turnRecoveryJobs[key] === coroutineContext[Job]) turnRecoveryJobs.remove(key)
            }
        }
    }

    private fun answerPreview(conversation: Conversation, active: ActiveTurn) {
        val threadKey = conversation.threadKey
        previewTurns[threadKey] = viewModelScope.launch {
            try {
                delay(650)
                val response = ChatMessage(
                    id = active.responseMessageId,
                    role = MessageRole.ASSISTANT,
                    content = "This is the local UI preview. A paired host streams the real answer through the resumable remote protocol.",
                    createdAtMillis = System.currentTimeMillis(),
                    model = conversation.model,
                    sourceName = "UI Preview",
                )
                _state.update { state ->
                    if (state.activeTurns[threadKey]?.requestId != active.requestId) return@update state
                    state.copy(
                        activeTurns = state.activeTurns - threadKey,
                        conversations = state.conversations.map {
                            if (it.threadKey == threadKey) it.copy(messages = it.messages + response) else it
                        },
                    )
                }
            } finally {
                val finishingJob = coroutineContext[Job]
                if (previewTurns[threadKey] === finishingJob) previewTurns.remove(threadKey)
            }
        }
    }

    fun stopTurn() {
        val state = _state.value
        val active = state.activeTurn ?: return
        val threadKey = ThreadKey(active.workspaceId, active.threadId)
        previewTurns.remove(threadKey)?.let { job ->
            job.cancel()
            _state.update { it.copy(activeTurns = it.activeTurns - threadKey, notice = "Turn stopped.", connectionNoticeHostId = null) }
            return
        }
        val conversation = state.activeConversation ?: return
        val host = state.activeWorkspace ?: return
        val projectId = conversation.projectId
        if (gateway == null || host.isPreview || projectId == null) {
            _state.update { it.copy(activeTurns = it.activeTurns - threadKey, notice = "Turn stopped.", connectionNoticeHostId = null) }
            return
        }
        val stopKey = threadKey to active.requestId
        if (!pendingStops.add(stopKey)) return
        val generation = connectionGenerations[host.id].orZero()
        val starting = localStarts[threadKey]?.takeIf { it.requestId == active.requestId }
        _state.update { current ->
            current.copy(activeTurns = current.activeTurns + (threadKey to active.copy(cancellationRequested = true)))
        }
        viewModelScope.launch {
            try {
                starting?.ready?.await()
                if (connectionGenerations[host.id].orZero() != generation ||
                    _state.value.activeTurns[threadKey]?.requestId != active.requestId) return@launch
                val result = sendRemoteCommand(gateway,
                    WorkspaceCommand.CancelTurn(
                        host.id,
                        projectId,
                        UUID.randomUUID().toString(),
                        conversation.id,
                        active.requestId,
                    ),
                )
                if (connectionGenerations[host.id].orZero() != generation ||
                    _state.value.activeTurns[threadKey]?.requestId != active.requestId) return@launch
                val error = result.exceptionOrNull()
                if (error != null) {
                    _state.update { current ->
                        val turn = current.activeTurns[threadKey]
                        if (turn?.requestId != active.requestId) current else current.copy(
                            activeTurns = current.activeTurns + (threadKey to turn.copy(cancellationRequested = false)),
                            notice = error.message ?: "The cancellation request was not delivered.",
                            connectionNoticeHostId = null,
                        )
                    }
                } else if (result.getOrThrow().disposition == CommandDisposition.ALREADY_FINISHED) {
                    confirmLocalStart(threadKey, active.requestId)
                    refreshHost(host.id).getOrNull()
                } else {
                    scheduleTurnRecovery(threadKey, active.requestId, generation)
                }
            } finally {
                pendingStops -= stopKey
            }
        }
    }

    fun steerTurn(note: String, now: Boolean = true) {
        val state = _state.value
        val active = state.activeTurn ?: return
        val conversation = state.activeConversation ?: return
        val host = state.activeWorkspace ?: return
        val projectId = conversation.projectId ?: return
        val remote = gateway ?: return
        if (note.isBlank()) return
        val generation = connectionGenerations[host.id].orZero()
        val starting = localStarts[conversation.threadKey]?.takeIf { it.requestId == active.requestId }
        viewModelScope.launch {
            starting?.ready?.await()
            if (connectionGenerations[host.id].orZero() != generation ||
                _state.value.activeTurns[conversation.threadKey]?.requestId != active.requestId) return@launch
            sendRemoteCommand(remote,
                WorkspaceCommand.SteerTurn(
                    host.id,
                    projectId,
                    UUID.randomUUID().toString(),
                    conversation.id,
                    active.requestId,
                    note,
                    now,
                ),
            ).onSuccess { receipt ->
                if (connectionGenerations[host.id].orZero() != generation) return@onSuccess
                if (receipt.disposition == CommandDisposition.ALREADY_FINISHED) {
                    notify("The response already finished. Send your note as a new message.")
                    refreshHost(host.id).getOrNull()
                }
            }.onFailure {
                if (connectionGenerations[host.id].orZero() == generation) notify(it.message ?: "The steering note was not delivered.")
            }
        }
    }

    /** Sends the active thread's draft as a live steering note while preserving the stop control. */
    fun submitSteer() {
        val state = _state.value
        if (!state.canSteer) return
        val active = state.activeTurn ?: return
        val conversation = state.activeConversation ?: return
        val host = state.activeWorkspace ?: return
        val projectId = conversation.projectId ?: return
        val remote = gateway ?: return
        val note = state.draft.text.trim()
        if (note.isEmpty()) return
        val steerKey = conversation.threadKey to active.requestId
        if (!pendingSteers.add(steerKey)) return
        val version = draftVersions[conversation.threadKey].orZero()
        val generation = connectionGenerations[host.id].orZero()
        val starting = localStarts[conversation.threadKey]?.takeIf { it.requestId == active.requestId }
        viewModelScope.launch {
            try {
                starting?.ready?.await()
                if (connectionGenerations[host.id].orZero() != generation) return@launch
                if (_state.value.activeTurns[conversation.threadKey]?.requestId != active.requestId) {
                    notify("The response already finished. Send your note as a new message.")
                    return@launch
                }
                sendRemoteCommand(remote,
                    WorkspaceCommand.SteerTurn(
                        host.id,
                        projectId,
                        UUID.randomUUID().toString(),
                        conversation.id,
                        active.requestId,
                        note,
                        true,
                    ),
                ).onSuccess { receipt ->
                    if (connectionGenerations[host.id].orZero() != generation) return@onSuccess
                    if (receipt.disposition == CommandDisposition.ALREADY_FINISHED) {
                        notify("The response already finished. Send your note as a new message.")
                        refreshHost(host.id).getOrNull()
                        return@onSuccess
                    }
                    _state.update { current ->
                        val currentDraft = current.drafts[conversation.threadKey] ?: return@update current
                        if (draftVersions[conversation.threadKey].orZero() != version || currentDraft.text.trim() != note) current else current.copy(
                            drafts = current.drafts + (conversation.threadKey to currentDraft.copy(text = "")),
                            notice = "Steering note sent.",
                            connectionNoticeHostId = null,
                        )
                    }
                    clearAcceptedDraft(conversation.threadKey)
                }.onFailure {
                    if (connectionGenerations[host.id].orZero() == generation) notify(it.message ?: "The steering note was not delivered.")
                }
            } finally {
                pendingSteers -= steerKey
            }
        }
    }

    private fun restorePairedHosts() {
        val remote = gateway ?: return
        val store = credentialStore ?: return
        viewModelScope.launch {
            _state.update { it.copy(isRestoringHosts = true) }
            try {
                val generations = connectionGenerations.toMap()
                val stored = withContext(storageDispatcher) { store.list() }.getOrElse { error ->
                    notify(error.message ?: "Saved connections could not be unlocked. Pair your computer again.")
                    return@launch
                }.filter { connection ->
                    generations[connection.hostId] == connectionGenerations[connection.hostId]
                }
                // Show every saved computer immediately, including those that are currently offline.
                _state.update { current -> current.copy(workspaces = current.workspaces + stored
                    .filter { connection -> current.workspaces.none { it.id == connection.hostId } }
                    .map { connection -> RemoteHost(connection.hostId, connection.endpoint.name,
                        connection.endpoint.baseUrl, ConnectionPhase.CONNECTING, "Connecting…") }) }
                coroutineScope {
                    stored.forEach { connection ->
                        val job = launch { restoreHost(remote, connection, makeActive = false) }
                        connectionJobs[connection.hostId] = job
                    }
                }
            } finally {
                _state.update { it.copy(isRestoringHosts = false) }
            }
        }
    }

    private suspend fun restoreHost(remote: RemoteWorkspaceGateway, stored: StoredHostCredential, makeActive: Boolean) {
        val selectedAt = selectionGeneration
        val generation = connectionGenerations[stored.hostId] ?: 0L
        pairedHostIds += stored.hostId
        restoreDrafts(stored.hostId)
        if (connectionGenerations[stored.hostId].orZero() != generation) return
        _state.update { current -> current.copy(workspaces = current.workspaces.map {
            if (it.id == stored.hostId) it.copy(phase = ConnectionPhase.CONNECTING, detail = "Connecting…", requiresPairing = false) else it
        }) }
        remote.connect(stored.endpoint, stored.credential).getOrElse { error ->
            if (connectionGenerations[stored.hostId].orZero() != generation) return
            markHostError(stored.hostId, error.message ?: "This computer is unreachable. Check that Antimatter is running and both devices are on the same network or VPN.",
                requiresPairing = needsNewPairing(error))
            return
        }
        if (connectionGenerations[stored.hostId].orZero() != generation) return
        val requestedAt = eventCursors[stored.hostId]
        val startsAcceptedAt = acceptedStartVersion
        val requestedThreadId = selectedThreadIdForHost(_state.value, stored.hostId)
        val snapshotSelectedAt = selectionGeneration
        val snapshot = remote.snapshot(stored.hostId, requestedThreadId).getOrElse { error ->
            if (connectionGenerations[stored.hostId].orZero() != generation) return
            if (shouldRetryRemoteCommand(error) && eventCursors[stored.hostId] != null &&
                _state.value.workspaces.any { it.id == stored.hostId && it.phase == ConnectionPhase.ONLINE }) {
                // A newer selection already recovered this host while bootstrap was in flight.
                startEventPolling(stored.hostId)
                return
            }
            markHostError(stored.hostId, error.message ?: "The host could not be loaded.", requiresPairing = needsNewPairing(error))
            return
        }
        val selectionMatches = selectionGeneration == snapshotSelectedAt ||
            requestedThreadId == selectedThreadIdForHost(_state.value, stored.hostId)
        val applied = selectionMatches && applySnapshot(
            snapshot,
            makeActive = selectionGeneration == selectedAt && (
                makeActive || _state.value.activeWorkspaceId == null || _state.value.activeWorkspace?.isPreview == true
            ),
            requestedAt = requestedAt,
            generation = generation,
            startsAcceptedAt = startsAcceptedAt,
        )
        // The snapshot cursor is authoritative regardless of whether navigation state changed.
        // A late snapshot can still provide the transport cursor needed to start event polling.
        if (!applied && selectionMatches && shouldApplyNetworkSnapshot(
            eventCursors[stored.hostId], requestedAt, snapshot.cursor
        )) {
            eventCursors[stored.hostId] = snapshot.cursor
        }
        // A thread selection can accept a newer snapshot while reconnect is in flight. Its
        // cursor is already authoritative, but reconnect still owns restarting the stopped poll.
        if (connectionGenerations[stored.hostId].orZero() == generation &&
            _state.value.workspaces.any { it.id == stored.hostId } && eventCursors[stored.hostId] != null) {
            startEventPolling(stored.hostId, needsInitialSnapshot = !applied)
        }
    }

    private fun applySnapshot(
        snapshot: WorkspaceSnapshot,
        makeActive: Boolean,
        requestedAt: EventCursor?,
        generation: Long,
        startsAcceptedAt: Long,
    ): Boolean {
        if (connectionGenerations[snapshot.host.id].orZero() != generation ||
            _state.value.workspaces.none { it.id == snapshot.host.id }) return false
        if (!shouldApplyNetworkSnapshot(eventCursors[snapshot.host.id], requestedAt, snapshot.cursor)) return false
        eventCursors[snapshot.host.id] = snapshot.cursor
        val draftsBefore = _state.value.drafts.keys
        _state.update { state ->
            val projectNames = snapshot.projects.associate { it.id to it.name }
            val oldById = state.conversations
                .filter { (it.hostId ?: it.workspaceId) == snapshot.host.id }
                .associateBy { it.id }
            val summaries = snapshot.conversations.map { summary ->
                val old = oldById[summary.id]
                if (old != null && !revisionAtLeast(summary.revision, old.revision)) return@map old
                (old ?: Conversation(
                    id = summary.id,
                    title = summary.title,
                    project = projectNames[summary.projectId] ?: "Project",
                    workspaceId = snapshot.host.id,
                    model = summary.model ?: snapshot.models.firstOrNull()?.key,
                    accessMode = AccessMode.ASK,
                    pinned = summary.pinned,
                    updatedAtMillis = summary.updatedAtMillis,
                    messages = emptyList(),
                    hostId = snapshot.host.id,
                    projectId = summary.projectId,
                    revision = summary.revision,
                    archived = summary.archived,
                )).copy(
                    title = summary.title,
                    project = projectNames[summary.projectId] ?: old?.project ?: "Project",
                    pinned = summary.pinned,
                    updatedAtMillis = summary.updatedAtMillis,
                    hostId = snapshot.host.id,
                    projectId = summary.projectId,
                    revision = summary.revision,
                    archived = summary.archived,
                    model = summary.model ?: old?.model ?: snapshot.models.firstOrNull()?.key,
                )
            }.toMutableList()
            snapshot.selectedThread?.conversation?.let { selected ->
                val index = summaries.indexOfFirst { it.id == selected.id }
                if (index < 0) {
                    summaries.add(0, selected)
                } else if (revisionAtLeast(selected.revision, summaries[index].revision)) {
                    summaries[index] = selected
                }
            }
            val selectHost = makeActive || state.activeWorkspace?.isPreview == true
            val activeKey = when {
                selectHost && snapshot.selectedThread != null -> snapshot.selectedThread.conversation.threadKey
                selectHost -> summaries.filterNot { it.archived }.maxByOrNull { it.updatedAtMillis }?.threadKey
                state.activeConversation?.let { (it.hostId ?: it.workspaceId) == snapshot.host.id } == true ->
                    state.activeConversationKey?.takeIf { key -> summaries.any { it.threadKey == key } }
                else -> state.activeConversationKey
            }
            val activeProject = summaries.firstOrNull { it.threadKey == activeKey }?.projectId
                ?: snapshot.projects.firstOrNull { it.isDefault }?.id
                ?: snapshot.projects.firstOrNull()?.id
            val localTurns = state.activeTurns.filterKeys { it.hostId == snapshot.host.id }
            val snapshotTurns = snapshot.activeTurns.associateBy { ThreadKey(snapshot.host.id, it.threadId) }
            // A snapshot may predate a local POST or its receipt. Only those starts need
            // protection; a later authoritative snapshot must clear missing/finished runs.
            val protectedTurns = localTurns.filter { (key, turn) ->
                val start = localStarts[key]
                start?.requestId == turn.requestId && start.generation == generation &&
                    (start.acceptedVersion == null || start.acceptedVersion!! > startsAcceptedAt)
            }
            val mergedTurns = protectedTurns + snapshotTurns.mapValues { (key, turn) ->
                val previous = localTurns[key]?.takeIf { it.requestId == turn.requestId }
                turn.copy(
                    cancellationRequested = turn.cancellationRequested || previous?.cancellationRequested == true,
                    inference = latestInference(previous?.inference, turn.inference),
                )
            }
            state.copy(
                workspaces = state.workspaces.filterNot { it.id == snapshot.host.id } + snapshot.host,
                notice = if (state.connectionNoticeHostId == snapshot.host.id) null else state.notice,
                connectionNoticeHostId = state.connectionNoticeHostId?.takeUnless { it == snapshot.host.id },
                projects = state.projects.filterNot { it.hostId == snapshot.host.id } + snapshot.projects,
                models = state.models.filterNot { it.workspaceId == snapshot.host.id } + snapshot.models,
                conversations = summaries + state.conversations.filterNot { (it.hostId ?: it.workspaceId) == snapshot.host.id },
                destination = if (selectHost && activeKey != null) AppDestination.CHAT else if (selectHost) AppDestination.WORKSPACES else state.destination,
                modelPickerOpen = if (selectHost) false else state.modelPickerOpen,
                activeWorkspaceId = if (selectHost) snapshot.host.id else state.activeWorkspaceId,
                activeProjectId = if (selectHost) activeProject else state.activeProjectId,
                activeConversationKey = activeKey,
                drafts = state.drafts.filterKeys { key ->
                    key.hostId != snapshot.host.id || summaries.any { it.threadKey == key }
                },
                activeTurns = state.activeTurns.filterKeys { it.hostId != snapshot.host.id } + mergedTurns,
            )
        }
        localStarts.keys.filter { it.hostId == snapshot.host.id }.toList().forEach { key ->
            val start = localStarts[key] ?: return@forEach
            val confirmed = snapshot.activeTurns.any { it.threadId == key.threadId && it.requestId == start.requestId }
            if (confirmed ||
                _state.value.activeTurns[key]?.requestId != start.requestId) {
                confirmLocalStart(key, start.requestId, accepted = confirmed)
            }
        }
        turnRecoveryJobs.keys.filter { it.hostId == snapshot.host.id && it !in _state.value.activeTurns }.toList().forEach {
            turnRecoveryJobs.remove(it)?.cancel()
        }
        (draftsBefore - _state.value.drafts.keys).forEach { key ->
            draftVersions[key] = draftVersions[key].orZero() + 1
            persistDraft(key, "")
        }
        return true
    }

    private class RestartEventPolling : RuntimeException()

    private fun startEventPolling(hostId: String, needsInitialSnapshot: Boolean = false) {
        val remote = gateway ?: return
        eventJobs.remove(hostId)?.cancel()
        val generation = connectionGenerations[hostId].orZero()
        eventJobs[hostId] = viewModelScope.launch {
            var retryDelay = 1_000L
            var needsSnapshot = needsInitialSnapshot
            while (isActive && connectionGenerations[hostId].orZero() == generation) {
                try {
                    if (needsSnapshot) {
                        refreshForPolling(hostId, generation)
                        needsSnapshot = false
                    }
                    val cursor = eventCursors[hostId]
                    if (cursor == null) {
                        markHostError(hostId, "Event cursor is missing. Reconnecting to restore event position.")
                        needsSnapshot = true
                        delay(retryDelay)
                        retryDelay = (retryDelay * 2L).coerceAtMost(30_000L)
                        continue
                    }
                    remote.events(hostId, cursor).collect { frame ->
                        if (connectionGenerations[hostId].orZero() != generation) throw CancellationException()
                        val resync = when (frame) {
                            is WorkspaceStreamFrame.Event -> applyEvent(frame.envelope)
                            is WorkspaceStreamFrame.Reset -> true
                        }
                        if (resync) {
                            // Stop this replay at the gap/invalidation. Later frames must never
                            // advance a transport-local cursor past an unapplied snapshot.
                            refreshForPolling(hostId, generation)
                            throw RestartEventPolling()
                        }
                        retryDelay = 1_000L
                    }
                    retryDelay = 1_000L
                    // A completed stream without a reset must not spin on a broken transport.
                    delay(100)
                } catch (_: RestartEventPolling) {
                    retryDelay = 1_000L
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    if (connectionGenerations[hostId].orZero() != generation) return@launch
                    val retryable = shouldRetryEventPolling(error)
                    markHostError(
                        hostId,
                        error.message ?: if (retryable) {
                            "Connection interrupted; retrying."
                        } else {
                            "This remote session is no longer valid. Pair this device again."
                        },
                        requiresPairing = needsNewPairing(error),
                    )
                    if (!retryable) break
                    needsSnapshot = true
                    delay(retryDelay)
                    retryDelay = (retryDelay * 2L).coerceAtMost(30_000L)
                }
            }
        }
    }

    private suspend fun refreshForPolling(hostId: String, generation: Long) {
        while (connectionGenerations[hostId].orZero() == generation &&
            _state.value.workspaces.any { it.id == hostId }) {
            if (refreshHost(hostId).getOrThrow()) return
            // Navigation can discard a successful HTTP response. It is not recovery until
            // a snapshot for the current transcript is accepted; avoid a tight retry loop.
            delay(100)
        }
        throw CancellationException()
    }

    private suspend fun refreshHost(
        hostId: String,
        selectedThreadId: String? = selectedThreadIdForHost(_state.value, hostId),
        makeActive: Boolean = false,
    ): Result<Boolean> {
        val remote = gateway ?: return Result.failure(IllegalStateException("Remote transport is unavailable."))
        // Bootstrap summaries are intentionally light. Ask the host to include the open transcript
        // when resynchronizing this host so an epoch reset cannot leave stale messages on screen.
        val requestedAt = eventCursors[hostId]
        val startsAcceptedAt = acceptedStartVersion
        val generation = connectionGenerations[hostId] ?: 0L
        val selectedAt = selectionGeneration
        return remote.snapshot(hostId, selectedThreadId).map { snapshot ->
            // This snapshot contains only the requested transcript. Once navigation changes,
            // accepting its global cursor could skip events for the newly opened transcript.
            if (selectionGeneration != selectedAt && selectedThreadId != selectedThreadIdForHost(_state.value, hostId)) {
                return@map false
            }
            applySnapshot(snapshot, makeActive = makeActive && selectionGeneration == selectedAt, requestedAt = requestedAt, generation = generation, startsAcceptedAt = startsAcceptedAt)
        }
    }

    /**
     * Retry one ambiguous transport/5xx failure with the exact same envelope. Reusing the command
     * ID is what lets the host return its durable receipt when the first 202 response was lost.
     */
    private suspend fun sendRemoteCommand(
        remote: RemoteWorkspaceGateway,
        command: WorkspaceCommand,
    ): Result<CommandReceipt> {
        val generation = connectionGenerations[command.hostId].orZero()
        val first = remote.send(command)
        if (connectionGenerations[command.hostId].orZero() != generation) throw CancellationException()
        val failure = first.exceptionOrNull() ?: return first
        if (!shouldRetryRemoteCommand(failure)) return first
        delay(300)
        if (connectionGenerations[command.hostId].orZero() != generation) throw CancellationException()
        return remote.send(command)
    }

    /** True means the polling owner must resynchronize before consuming another frame. */
    private fun applyEvent(envelope: WorkspaceEventEnvelope): Boolean {
        val current = eventCursors[envelope.hostId]
        when (classifyCursor(current, envelope.cursor)) {
            CursorDisposition.DUPLICATE -> return false
            CursorDisposition.RESYNC -> return true
            CursorDisposition.APPLY -> Unit
        }
        if (envelope.event is WorkspaceEvent.CatalogChanged || envelope.event is WorkspaceEvent.ThreadChanged) {
            // Summaries do not include the user message or active turn. Refresh even a known
            // thread so turns started by another device become visible and controllable.
            return true
        }
        if (envelope.threadId != null && !hasThread(envelope.hostId, envelope.threadId) &&
            envelope.event !is WorkspaceEvent.ThreadDeleted) return true
        _state.update { state -> reduceEvent(state, envelope) }
        val requestId = when (val event = envelope.event) {
            is WorkspaceEvent.TextDelta -> event.requestId
            is WorkspaceEvent.Liveness -> event.requestId
            is WorkspaceEvent.ToolChanged -> event.activity.requestId
            is WorkspaceEvent.ApprovalRequested -> event.activity.requestId
            is WorkspaceEvent.ContextUpdated -> event.requestId
            is WorkspaceEvent.TurnFinished -> event.requestId
            is WorkspaceEvent.TurnFailed -> event.requestId
            else -> null
        }
        if (envelope.threadId != null && requestId != null) {
            val key = ThreadKey(envelope.hostId, envelope.threadId)
            confirmLocalStart(key, requestId)
            if (_state.value.activeTurns[key] == null) turnRecoveryJobs.remove(key)?.cancel()
        }
        if (envelope.event is WorkspaceEvent.ThreadDeleted) {
            envelope.threadId?.let { threadId ->
                val key = ThreadKey(envelope.hostId, threadId)
                draftVersions[key] = draftVersions[key].orZero() + 1
                persistDraft(key, "")
            }
        }
        // A receipt only proves acceptance; refresh if durable dispatch later failed.
        if (envelope.event is WorkspaceEvent.CommandFailed) return true
        eventCursors[envelope.hostId] = envelope.cursor
        return false
    }

    private fun hasThread(hostId: String, threadId: String): Boolean = _state.value.conversations.any {
        it.id == threadId && (it.hostId ?: it.workspaceId) == hostId
    }

    private fun reduceEvent(state: AntimatterUiState, envelope: WorkspaceEventEnvelope): AntimatterUiState {
        val threadId = envelope.threadId
        val threadKey = threadId?.let { ThreadKey(envelope.hostId, it) }
        return when (val event = envelope.event) {
            is WorkspaceEvent.TextDelta -> state.copy(conversations = state.conversations.map { conversation ->
                if (conversation.threadKey != threadKey) conversation
                else conversation.copy(messages = appendText(conversation.messages, event))
            })
            is WorkspaceEvent.Liveness -> if (threadKey == null) state else state.copy(
                activeTurns = state.activeTurns[threadKey]?.takeIf { it.requestId == event.requestId }?.let { turn ->
                    state.activeTurns + (threadKey to turn.copy(waiting = event.waiting))
                } ?: state.activeTurns,
            )
            is WorkspaceEvent.ToolChanged -> updateTool(state, envelope, event.activity)
            is WorkspaceEvent.ApprovalRequested -> updateTool(state, envelope, event.activity)
            is WorkspaceEvent.ApprovalResolved -> updateApproval(
                state,
                envelope,
                event.requestId,
                event.approvalId,
                event.resolution.name,
            )
            is WorkspaceEvent.SteerAcknowledged -> state.copy(notice = "Steering note delivered.", connectionNoticeHostId = null)
            is WorkspaceEvent.ContextUpdated -> if (threadKey == null) state else state.copy(
                activeTurns = state.activeTurns[threadKey]?.takeIf { it.requestId == event.requestId }?.let { turn ->
                    state.activeTurns + (threadKey to turn.copy(inference = latestInference(turn.inference, event.inference)))
                } ?: state.activeTurns,
            )
            is WorkspaceEvent.PreviewReady -> updatePreview(state, envelope, event)
            is WorkspaceEvent.ThreadChanged -> {
                val summary = event.summary
                state.copy(conversations = state.conversations.map {
                    if (it.id == summary.id && (it.hostId ?: it.workspaceId) == envelope.hostId) {
                        it.copy(
                            title = summary.title,
                            pinned = summary.pinned,
                            archived = summary.archived,
                            updatedAtMillis = summary.updatedAtMillis,
                            revision = summary.revision,
                            model = summary.model ?: it.model,
                        )
                    } else it
                })
            }
            WorkspaceEvent.ThreadDeleted -> {
                if (threadKey == null) state else {
                    val remaining = state.conversations.filterNot {
                        it.threadKey == threadKey
                    }
                    val replacement = remaining
                        .filter { (it.hostId ?: it.workspaceId) == envelope.hostId }
                        .maxByOrNull { it.updatedAtMillis }
                        ?: remaining.firstOrNull()
                    state.copy(
                        conversations = remaining,
                        activeConversationKey = if (state.activeConversationKey == threadKey) replacement?.threadKey else state.activeConversationKey,
                        activeWorkspaceId = if (state.activeConversationKey == threadKey) {
                            replacement?.hostId ?: replacement?.workspaceId ?: state.activeWorkspaceId
                        } else state.activeWorkspaceId,
                        activeProjectId = if (state.activeConversationKey == threadKey) replacement?.projectId else state.activeProjectId,
                        activeTurns = state.activeTurns - threadKey,
                        drafts = state.drafts - threadKey,
                    )
                }
            }
            is WorkspaceEvent.CatalogChanged -> state
            is WorkspaceEvent.CommandFailed -> state.copy(notice = event.userMessage, connectionNoticeHostId = null)
            is WorkspaceEvent.TurnFinished -> if (
                threadKey == null || state.activeTurns[threadKey]?.requestId != event.requestId
            ) state else state.copy(activeTurns = state.activeTurns - threadKey)
            is WorkspaceEvent.TurnFailed -> {
                if (threadKey == null) state.copy(notice = event.userMessage, connectionNoticeHostId = null) else state.copy(
                    activeTurns = if (state.activeTurns[threadKey]?.requestId == event.requestId) {
                        state.activeTurns - threadKey
                    } else state.activeTurns,
                    notice = event.userMessage,
                    connectionNoticeHostId = null,
                    conversations = state.conversations.map { conversation ->
                        if (conversation.threadKey != threadKey) conversation else conversation.copy(
                            messages = markFailed(conversation.messages, event.responseMessageId, event.userMessage),
                        )
                    },
                )
            }
            is WorkspaceEvent.Unknown -> state
        }
    }

    private fun appendText(messages: List<ChatMessage>, event: WorkspaceEvent.TextDelta): List<ChatMessage> {
        val existing = messages.indexOfFirst { it.id == event.responseMessageId }
        if (existing < 0) return messages + ChatMessage(
            id = event.responseMessageId,
            role = MessageRole.ASSISTANT,
            content = event.content,
            createdAtMillis = System.currentTimeMillis(),
        )
        return messages.mapIndexed { index, message ->
            if (index == existing) message.copy(content = message.content + event.content) else message
        }
    }

    private fun updateTool(
        state: AntimatterUiState,
        envelope: WorkspaceEventEnvelope,
        activity: ToolActivity,
    ): AntimatterUiState {
        val threadId = envelope.threadId ?: return state
        val threadKey = ThreadKey(envelope.hostId, threadId)
        val responseId = state.activeTurns[threadKey]?.takeIf { it.requestId == activity.requestId }?.responseMessageId
        return state.copy(conversations = state.conversations.map { conversation ->
            if (conversation.threadKey != threadKey) return@map conversation
            val messageIndex = conversation.messages.indexOfLast { message ->
                message.id == responseId || message.tools.any { sameActivity(it, activity) }
            }
            if (messageIndex < 0) {
                conversation.copy(messages = conversation.messages + ChatMessage(
                    id = responseId ?: "response-${activity.requestId}",
                    role = MessageRole.ASSISTANT,
                    content = "",
                    createdAtMillis = System.currentTimeMillis(),
                    tools = listOf(activity),
                ))
            } else conversation.copy(messages = conversation.messages.mapIndexed { index, message ->
                if (index != messageIndex) message else message.copy(
                    tools = if (message.tools.any { sameActivity(it, activity) }) {
                        message.tools.map { if (sameActivity(it, activity)) activity else it }
                    } else message.tools + activity,
                )
            })
        })
    }

    private fun sameActivity(left: ToolActivity, right: ToolActivity): Boolean =
        left.activityId?.let { it == right.activityId } ?: (left.callId == right.callId && left.requestId == right.requestId)

    private fun updateApproval(
        state: AntimatterUiState,
        envelope: WorkspaceEventEnvelope,
        requestId: String,
        approvalId: String,
        resolution: String,
    ): AntimatterUiState = state.copy(conversations = state.conversations.map { conversation ->
        val key = envelope.threadId?.let { ThreadKey(envelope.hostId, it) }
        if (conversation.threadKey != key) conversation else conversation.copy(messages = conversation.messages.map { message ->
            message.copy(tools = message.tools.map { activity ->
                if (activity.requestId != requestId || activity.approvalId != approvalId) activity else activity.copy(
                    awaitingApproval = false,
                    status = if (resolution == "APPROVED") ToolStatus.PENDING else ToolStatus.DENIED,
                )
            })
        })
    })

    private fun updatePreview(
        state: AntimatterUiState,
        envelope: WorkspaceEventEnvelope,
        event: WorkspaceEvent.PreviewReady,
    ): AntimatterUiState = state.copy(conversations = state.conversations.map { conversation ->
        val key = envelope.threadId?.let { ThreadKey(envelope.hostId, it) }
        if (conversation.threadKey != key) conversation else conversation.copy(messages = conversation.messages.map { message ->
            if (event.responseMessageId != null && message.id != event.responseMessageId) message else message.copy(
                tools = message.tools.map { tool ->
                    if (event.activityId != null && tool.activityId == event.activityId) tool.copy(preview = event.preview) else tool
                },
            )
        })
    })

    private fun markFailed(messages: List<ChatMessage>, responseId: String?, userMessage: String): List<ChatMessage> {
        val id = responseId ?: return messages
        if (messages.any { it.id == id }) return messages.map {
            if (it.id == id) it.copy(failed = true, content = it.content.ifBlank { userMessage }) else it
        }
        return messages + ChatMessage(id, MessageRole.ASSISTANT, userMessage, System.currentTimeMillis(), failed = true)
    }

    private fun failLocalTurn(threadKey: ThreadKey, active: ActiveTurn, message: String) {
        _state.update { state ->
            if (state.activeTurns[threadKey]?.requestId != active.requestId) state else state.copy(
                activeTurns = state.activeTurns - threadKey,
                notice = message,
                connectionNoticeHostId = null,
                conversations = state.conversations.map { conversation ->
                    if (conversation.threadKey != threadKey) conversation else conversation.copy(
                        messages = markFailed(conversation.messages, active.responseMessageId, message),
                    )
                },
            )
        }
    }

    private fun loadThread(hostId: String, projectId: String?, threadId: String, quiet: Boolean) {
        val remote = gateway ?: return
        viewModelScope.launch {
            if (projectId == null) {
                refreshHost(hostId, threadId).onFailure {
                    if (!quiet) notify(it.message ?: "The conversation could not be loaded.")
                }
                return@launch
            }
            refreshHost(hostId, threadId).onFailure {
                if (!quiet) notify(it.message ?: "The conversation could not be loaded.")
            }
        }
    }

    private fun markHostError(hostId: String, message: String, requiresPairing: Boolean = false, connectionNotice: Boolean = true) {
        _state.update { state ->
            state.copy(
                workspaces = state.workspaces.map {
                    if (it.id == hostId) it.copy(phase = ConnectionPhase.ERROR, detail = message, requiresPairing = requiresPairing) else it
                },
                notice = message,
                connectionNoticeHostId = hostId.takeIf { connectionNotice },
            )
        }
    }

    class Factory(
        private val gateway: RemoteWorkspaceGateway,
        private val credentialStore: WorkspaceCredentialStore,
        private val deviceName: String,
        private val clientVersion: String,
        private val draftStore: DraftStore? = null,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass.isAssignableFrom(AntimatterViewModel::class.java))
            return AntimatterViewModel(
                gateway = gateway,
                credentialStore = credentialStore,
                deviceName = deviceName,
                clientVersion = clientVersion,
                draftStore = draftStore,
            ) as T
        }
    }

    private companion object {
        fun disconnectedState(): AntimatterUiState {
            return AntimatterUiState(destination = AppDestination.WORKSPACES)
        }
    }
}

internal fun needsNewPairing(error: Throwable): Boolean =
    (error as? RemoteWorkspaceException)?.code in setOf(
        co.antimatter.app.remote.RemoteFailureCode.AUTHENTICATION,
        co.antimatter.app.remote.RemoteFailureCode.TLS_PIN_MISMATCH,
    )

private fun Long?.orZero(): Long = this ?: 0L

internal fun shouldRetryEventPolling(error: Throwable): Boolean =
    (error as? RemoteWorkspaceException)?.retryable != false

internal fun shouldRetryRemoteCommand(error: Throwable): Boolean {
    val remote = error as? RemoteWorkspaceException ?: return false
    return remote.retryable && (
        remote.code == co.antimatter.app.remote.RemoteFailureCode.NETWORK ||
            remote.code == co.antimatter.app.remote.RemoteFailureCode.HOST_UNAVAILABLE ||
            remote.httpStatus?.let { it in 500..599 } == true
        )
}

internal fun selectedThreadIdForHost(state: AntimatterUiState, hostId: String): String? =
    state.activeConversation
        ?.takeIf { (it.hostId ?: it.workspaceId) == hostId }
        ?.id

internal fun revisionAtLeast(incoming: String?, current: String?): Boolean {
    if (current == null) return true
    if (incoming == null) return false
    val incomingNumber = incoming.toLongOrNull()
    val currentNumber = current.toLongOrNull()
    return if (incomingNumber != null && currentNumber != null) incomingNumber >= currentNumber else incoming == current
}
