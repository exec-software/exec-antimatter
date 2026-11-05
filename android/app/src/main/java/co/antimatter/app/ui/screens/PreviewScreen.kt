package co.antimatter.app.ui.screens

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import co.antimatter.app.domain.PreviewKind
import co.antimatter.app.domain.PreviewRef
import co.antimatter.app.ui.theme.ClayBorder
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClayRaised
import co.antimatter.app.ui.theme.ClaySurface
import co.antimatter.app.ui.theme.ClayText
import co.antimatter.app.ui.theme.ClayTextMuted

@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
fun PreviewScreen(
    preview: PreviewRef?,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(
                        preview?.title ?: "Preview",
                        color = ClayText,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (preview is PreviewRef.ExternalPage) {
                        Text(
                            validatedHttpsUri(preview.url)?.host ?: "Invalid address",
                            color = ClayTextMuted,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
            },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back to conversation",
                        tint = ClayTextMuted,
                    )
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = ClaySurface),
        )

        when (preview) {
            null -> PreviewUnavailable("This preview is no longer available.", Modifier.weight(1f))
            is PreviewRef.ExternalPage -> SecureWebPreview(preview.url, Modifier.weight(1f))
            is PreviewRef.Asset -> PreviewUnavailable(
                message = when (preview.kind) {
                    PreviewKind.IMAGE -> "The image is ready on the host. It will load here after the authenticated asset transport is connected."
                    PreviewKind.PAGE -> "The page is ready on the host. It will load here after the authenticated asset transport is connected."
                },
                modifier = Modifier.weight(1f),
                image = preview.kind == PreviewKind.IMAGE,
            )
        }
    }
}

@Composable
private fun PreviewUnavailable(
    message: String,
    modifier: Modifier = Modifier,
    image: Boolean = false,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(
            color = ClayRaised,
            border = BorderStroke(1.dp, ClayBorder),
            shape = MaterialTheme.shapes.large,
        ) {
            Icon(
                if (image) Icons.Outlined.Image else Icons.Outlined.Language,
                contentDescription = null,
                tint = ClayPrimary,
                modifier = Modifier.padding(22.dp),
            )
        }
        Spacer(Modifier.height(18.dp))
        Text(
            message,
            color = ClayTextMuted,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun SecureWebPreview(url: String, modifier: Modifier = Modifier) {
    val initialUri = remember(url) { validatedHttpsUri(url) }
    if (initialUri == null) {
        PreviewUnavailable("The host supplied an invalid web preview address.", modifier)
        return
    }

    var loading by remember(url) { mutableStateOf(true) }
    var blockedNavigation by remember(url) { mutableStateOf(false) }
    var webView: WebView? by remember(url) { mutableStateOf(null) }

    Column(modifier = modifier.fillMaxSize()) {
        if (loading) {
            LinearProgressIndicator(
                color = ClayPrimary,
                trackColor = ClayRaised,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (blockedNavigation) {
            Text(
                "A cross-origin or non-HTTPS navigation was blocked.",
                color = ClayTextMuted,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        AndroidView(
            factory = { context ->
                WebView(context).also { view ->
                    webView = view
                    with(view.settings) {
                        javaScriptEnabled = false
                        domStorageEnabled = false
                        allowFileAccess = false
                        allowContentAccess = false
                        mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        safeBrowsingEnabled = true
                        mediaPlaybackRequiresUserGesture = true
                        setSupportMultipleWindows(false)
                    }
                    CookieManager.getInstance().apply {
                        setAcceptCookie(false)
                        setAcceptThirdPartyCookies(view, false)
                        removeAllCookies {
                            view.post {
                                if (webView === view) view.loadUrl(initialUri.toString())
                            }
                        }
                    }
                    view.webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                            loading = true
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            loading = false
                        }

                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                            val requested = request.url
                            val allowed = requested.scheme.equals("https", ignoreCase = true) &&
                                requested.host.equals(initialUri.host, ignoreCase = true) &&
                                effectivePort(requested) == effectivePort(initialUri)
                            if (!allowed) blockedNavigation = true
                            return !allowed
                        }
                    }
                }
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
    }

    DisposableEffect(url) {
        onDispose {
            webView?.apply {
                stopLoading()
                loadUrl("about:blank")
                clearCache(true)
                clearHistory()
                removeAllViews()
                destroy()
            }
            CookieManager.getInstance().apply {
                removeAllCookies { flush() }
            }
            WebStorage.getInstance().deleteAllData()
            webView = null
        }
    }
}

private fun validatedHttpsUri(raw: String): Uri? = runCatching {
    val uri = raw.toUri()
    require(uri.scheme.equals("https", ignoreCase = true))
    require(!uri.host.isNullOrBlank())
    require(uri.userInfo == null)
    require(uri.port == -1 || uri.port in 1..65_535)
    uri
}.getOrNull()

private fun effectivePort(uri: Uri): Int = when {
    uri.port != -1 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    else -> -1
}
