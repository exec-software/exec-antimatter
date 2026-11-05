package co.antimatter.app.remote

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/** Pure, offline QR decoder. It has no Android service, network, telemetry, or persistence path. */
internal class OfflineQrDecoder {
    private val reader = QRCodeReader()
    private val hints = mapOf(
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.CHARACTER_SET to Charsets.UTF_8.name(),
    )

    fun decode(luma: ByteArray, width: Int, height: Int, rotationDegrees: Int): String? {
        require(width > 0 && height > 0 && luma.size == width * height) { "Invalid luminance frame." }
        val frame = rotateLuma(luma, width, height, rotationDegrees)
        val source = PlanarYUVLuminanceSource(
            frame.bytes,
            frame.width,
            frame.height,
            0,
            0,
            frame.width,
            frame.height,
            false,
        )
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (_: ReaderException) {
            null
        } finally {
            reader.reset()
        }
    }
}

internal data class LumaFrame(val bytes: ByteArray, val width: Int, val height: Int)

internal fun rotateLuma(source: ByteArray, width: Int, height: Int, rotationDegrees: Int): LumaFrame {
    require(width > 0 && height > 0 && source.size == width * height) { "Invalid luminance frame." }
    val normalized = ((rotationDegrees % 360) + 360) % 360
    require(normalized % 90 == 0) { "Frame rotation must be a right angle." }
    if (normalized == 0) return LumaFrame(source, width, height)

    val rotated = ByteArray(source.size)
    for (y in 0 until height) {
        for (x in 0 until width) {
            val value = source[y * width + x]
            when (normalized) {
                90 -> rotated[x * height + (height - 1 - y)] = value
                180 -> rotated[(height - 1 - y) * width + (width - 1 - x)] = value
                270 -> rotated[(width - 1 - x) * height + y] = value
            }
        }
    }
    return if (normalized == 180) {
        LumaFrame(rotated, width, height)
    } else {
        LumaFrame(rotated, height, width)
    }
}
