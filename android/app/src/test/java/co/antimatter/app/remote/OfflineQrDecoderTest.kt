package co.antimatter.app.remote

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.net.URLEncoder
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class OfflineQrDecoderTest {
    @Test
    fun `pure decoder reads only local luminance data at every camera rotation`() {
        val payload = "ANTIMATTER-PAIRING-V1?offline-decoder-test"
        val size = 360
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)
        val luma = ByteArray(size * size) { index ->
            if (matrix[index % size, index / size]) 0 else 0xff.toByte()
        }

        listOf(0, 90, 180, 270).forEach { rotation ->
            assertEquals(payload, OfflineQrDecoder().decode(luma, size, size, rotation))
        }
    }

    @Test
    fun `luminance rotation preserves dimensions and pixel order`() {
        val original = byteArrayOf(1, 2, 3, 4, 5, 6)

        rotateLuma(original, width = 3, height = 2, rotationDegrees = 90).also {
            assertEquals(2, it.width)
            assertEquals(3, it.height)
            assertArrayEquals(byteArrayOf(4, 1, 5, 2, 6, 3), it.bytes)
        }
        rotateLuma(original, width = 3, height = 2, rotationDegrees = 180).also {
            assertEquals(3, it.width)
            assertEquals(2, it.height)
            assertArrayEquals(byteArrayOf(6, 5, 4, 3, 2, 1), it.bytes)
        }
        rotateLuma(original, width = 3, height = 2, rotationDegrees = 270).also {
            assertEquals(2, it.width)
            assertEquals(3, it.height)
            assertArrayEquals(byteArrayOf(3, 6, 2, 5, 1, 4), it.bytes)
        }
    }

    @Test
    fun `dense real pairing payload decodes inside a landscape camera frame`() {
        val now = System.currentTimeMillis()
        val fields = linkedMapOf(
            "endpoint" to "https://198.51.100.123:43128",
            "host" to "_A234567890123456789012",
            "offer" to "-B234567890123456789012",
            "secret" to "c".repeat(43),
            "pin" to "sha256/${Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })}",
            "expires" to (now + 120_000).toString(),
        )
        val payload = "ANTIMATTER-PAIRING-V1?" + fields.entries.joinToString("&") { (key, value) ->
            "$key=${URLEncoder.encode(value, Charsets.UTF_8.name())}"
        }
        val qrSize = 384
        val width = 1280
        val height = 960
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, qrSize, qrSize)
        val frame = ByteArray(width * height) { 0xee.toByte() }
        for (row in 0 until qrSize) {
            for (column in 0 until qrSize) {
                frame[(row + (height - qrSize) / 2) * width + column + (width - qrSize) / 2] =
                    if (matrix[column, row]) 0 else 0xff.toByte()
            }
        }
        for (rotation in listOf(0, 90, 180, 270)) {
            val decoded = OfflineQrDecoder().decode(frame, width, height, rotation)
            assertEquals(payload, decoded)
            assertEquals("_A234567890123456789012", PairingOffer.parse(decoded!!, now).getOrThrow().hostId)
        }
    }
}
