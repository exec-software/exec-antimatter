package co.antimatter.app

import android.os.Bundle
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import co.antimatter.app.remote.HttpsRemoteWorkspaceGateway
import co.antimatter.app.remote.KeystoreCredentialStore
import co.antimatter.app.data.KeystoreDraftStore
import co.antimatter.app.ui.AntimatterApp
import co.antimatter.app.ui.AntimatterViewModel
import co.antimatter.app.ui.theme.AntimatterTheme

class MainActivity : ComponentActivity() {
    private lateinit var antimatterViewModel: AntimatterViewModel

    override fun onStart() {
        super.onStart()
        if (::antimatterViewModel.isInitialized) antimatterViewModel.resumeConnections()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val credentialStore = KeystoreCredentialStore(applicationContext)
        val gateway = HttpsRemoteWorkspaceGateway(credentialStore)
        antimatterViewModel = ViewModelProvider(
            this,
            AntimatterViewModel.Factory(
                gateway = gateway,
                credentialStore = credentialStore,
                deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
                clientVersion = BuildConfig.VERSION_NAME,
                draftStore = KeystoreDraftStore(applicationContext),
            ),
        )[AntimatterViewModel::class.java]
        setContent {
            AntimatterTheme {
                AntimatterApp(antimatterViewModel)
            }
        }
    }
}
