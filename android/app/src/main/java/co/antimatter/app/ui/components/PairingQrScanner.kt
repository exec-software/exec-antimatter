package co.antimatter.app.ui.components

import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import co.antimatter.app.remote.OfflineQrDecoder
import co.antimatter.app.remote.PairingScanDecision
import co.antimatter.app.remote.PairingScanGate
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Camera contents and decoded QR values stay in memory only for the current scanner session. */
@Composable
internal fun PairingQrScanner(
    onPairingCode: (String) -> Unit,
    onGuidance: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val decoder = remember { OfflineQrDecoder() }
    val gate = remember { PairingScanGate() }
    val active = remember { AtomicBoolean(true) }
    val foreground = remember { AtomicBoolean(false) }
    val processing = remember { AtomicBoolean(false) }
    val currentOnPairingCode = rememberUpdatedState(onPairingCode)
    val currentOnGuidance = rememberUpdatedState(onGuidance)
    val cameraController = remember(context) {
        LifecycleCameraController(context).apply {
            cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
            imageAnalysisBackpressureStrategy = ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST
            // Pairing QRs carry an endpoint, certificate pin, and bearer. Keep enough pixels for
            // their dense modules; CameraX's low default analysis resolution can blur them together.
            imageAnalysisResolutionSelector = ResolutionSelector.Builder()
                .setResolutionStrategy(ResolutionStrategy(
                    Size(1280, 960),
                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                ))
                .build()
            isTapToFocusEnabled = true
            isPinchToZoomEnabled = true
            setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
        }
    }
    val analyzer = remember(decoder, gate) {
        pairingAnalyzer(
            decoder = decoder,
            gate = gate,
            active = active,
            foreground = foreground,
            processing = processing,
            callbackExecutor = mainExecutor,
            onAccepted = { rawValue ->
                if (active.compareAndSet(true, false)) {
                    cameraController.clearImageAnalysisAnalyzer()
                    cameraController.unbind()
                    currentOnPairingCode.value(rawValue)
                }
            },
            onGuidance = { currentOnGuidance.value(it) },
        )
    }

    DisposableEffect(lifecycleOwner, cameraController, analyzer) {
        fun bindIfForeground() {
            if (active.get() && lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                try {
                    foreground.set(true)
                    cameraController.setImageAnalysisAnalyzer(analysisExecutor, analyzer)
                    cameraController.bindToLifecycle(lifecycleOwner)
                } catch (_: RuntimeException) {
                    foreground.set(false)
                    cameraController.clearImageAnalysisAnalyzer()
                    cameraController.unbind()
                    currentOnGuidance.value("The camera could not start. You can still paste the pairing code.")
                }
            }
        }

        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> bindIfForeground()
                Lifecycle.Event.ON_STOP -> {
                    foreground.set(false)
                    cameraController.clearImageAnalysisAnalyzer()
                    cameraController.unbind()
                }
                Lifecycle.Event.ON_DESTROY -> {
                    foreground.set(false)
                    active.set(false)
                    cameraController.clearImageAnalysisAnalyzer()
                    cameraController.unbind()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        bindIfForeground()

        onDispose {
            foreground.set(false)
            active.set(false)
            lifecycleOwner.lifecycle.removeObserver(observer)
            cameraController.clearImageAnalysisAnalyzer()
            cameraController.unbind()
            analysisExecutor.shutdownNow()
        }
    }

    Box(modifier = modifier) {
        AndroidView(
            factory = { viewContext ->
                PreviewView(viewContext).apply {
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                    controller = cameraController
                }
            },
            update = { it.controller = cameraController },
            modifier = Modifier.fillMaxSize(),
        )
        Box(
            modifier = Modifier
                .align(Alignment.Center)
                .size(230.dp)
                .border(2.dp, Color.White.copy(alpha = 0.9f), RoundedCornerShape(24.dp)),
        )
    }
}

private fun pairingAnalyzer(
    decoder: OfflineQrDecoder,
    gate: PairingScanGate,
    active: AtomicBoolean,
    foreground: AtomicBoolean,
    processing: AtomicBoolean,
    callbackExecutor: Executor,
    onAccepted: (String) -> Unit,
    onGuidance: (String) -> Unit,
): ImageAnalysis.Analyzer = ImageAnalysis.Analyzer { imageProxy ->
    if (!active.get() || !foreground.get() || !processing.compareAndSet(false, true)) {
        imageProxy.close()
        return@Analyzer
    }
    val rawValue = try {
        decoder.decode(
            luma = imageProxy.copyLumaPlane(),
            width = imageProxy.width,
            height = imageProxy.height,
            rotationDegrees = imageProxy.imageInfo.rotationDegrees,
        )
    } catch (_: RuntimeException) {
        null
    } finally {
        // The synchronous decoder always releases the CameraX frame exactly once, including when
        // the screen is dismissed or backgrounded while analysis is running.
        imageProxy.close()
    }
    if (rawValue == null) {
        processing.set(false)
        return@Analyzer
    }

    try {
        callbackExecutor.execute {
            try {
                if (!active.get() || !foreground.get()) return@execute
                when (val decision = gate.evaluate(rawValue)) {
                    PairingScanDecision.Accept -> {
                        // The raw value is handed directly to the existing strict parser path.
                        // It is never placed in Compose state, persisted, copied, or logged.
                        onAccepted(rawValue)
                    }
                    PairingScanDecision.Ignore -> Unit
                    is PairingScanDecision.Reject -> onGuidance(decision.guidance)
                }
            } finally {
                processing.set(false)
            }
        }
    } catch (_: RuntimeException) {
        processing.set(false)
    }
}

private fun ImageProxy.copyLumaPlane(): ByteArray {
    val plane = planes.first()
    val buffer = plane.buffer.duplicate().apply { rewind() }
    val output = ByteArray(width * height)
    if (plane.pixelStride == 1 && plane.rowStride == width && buffer.remaining() >= output.size) {
        buffer.get(output)
        return output
    }

    val limit = buffer.limit()
    for (row in 0 until height) {
        val rowOffset = row * plane.rowStride
        for (column in 0 until width) {
            val sourceIndex = rowOffset + column * plane.pixelStride
            if (sourceIndex >= limit) {
                throw IllegalArgumentException("Camera luminance plane is truncated.")
            }
            output[row * width + column] = buffer.get(sourceIndex)
        }
    }
    return output
}
