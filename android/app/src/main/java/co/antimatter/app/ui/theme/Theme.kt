package co.antimatter.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val ClayScheme = darkColorScheme(
    primary = ClayPrimary,
    onPrimary = ClayPage,
    primaryContainer = ClayRaised,
    onPrimaryContainer = ClayPrimaryPressed,
    secondary = ClayAccent,
    onSecondary = ClayPage,
    secondaryContainer = ClaySurfaceAlt,
    onSecondaryContainer = ClayAccentPressed,
    tertiary = ClayTextMuted,
    background = ClayPage,
    onBackground = ClayText,
    surface = ClaySurface,
    onSurface = ClayText,
    surfaceVariant = ClaySurfaceAlt,
    onSurfaceVariant = ClayTextMuted,
    surfaceContainer = ClaySurface,
    surfaceContainerHigh = ClayRaised,
    outline = ClayBorder,
    outlineVariant = ClayBorderMuted,
    error = ClayError,
    onError = ClayPage,
)

@Composable
fun AntimatterTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    // Antimatter intentionally keeps Clay instead of replacing product identity with dynamic color.
    MaterialTheme(
        colorScheme = ClayScheme,
        typography = AntimatterTypography,
        shapes = AntimatterShapes,
        content = content,
    )
}
