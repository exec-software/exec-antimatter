package co.antimatter.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import co.antimatter.app.ui.theme.ClayAccent
import co.antimatter.app.ui.theme.ClayPrimary
import co.antimatter.app.ui.theme.ClayText

@Composable
fun AtomMark(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val stroke = size.minDimension * 0.055f
        val rect = Rect(
            left = size.width * 0.14f,
            top = size.height * 0.33f,
            right = size.width * 0.86f,
            bottom = size.height * 0.67f,
        )
        drawOval(ClayAccent, rect.topLeft, rect.size, style = Stroke(stroke, cap = StrokeCap.Round))
        rotate(60f, pivot = center) {
            drawOval(ClayPrimary, rect.topLeft, rect.size, style = Stroke(stroke, cap = StrokeCap.Round))
        }
        rotate(120f, pivot = center) {
            drawOval(ClayText, rect.topLeft, rect.size, style = Stroke(stroke * 0.8f, cap = StrokeCap.Round))
        }
        drawCircle(ClayPrimary, radius = size.minDimension * 0.085f, center = Offset(size.width / 2, size.height / 2))
    }
}
