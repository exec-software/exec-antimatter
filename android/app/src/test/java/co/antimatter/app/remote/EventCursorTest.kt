package co.antimatter.app.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class EventCursorTest {
    @Test
    fun `cursor reducer applies only the next event`() {
        val current = EventCursor("epoch-a", 8)

        assertEquals(CursorDisposition.APPLY, classifyCursor(current, EventCursor("epoch-a", 9)))
        assertEquals(CursorDisposition.DUPLICATE, classifyCursor(current, EventCursor("epoch-a", 8)))
        assertEquals(CursorDisposition.DUPLICATE, classifyCursor(current, EventCursor("epoch-a", 2)))
    }

    @Test
    fun `cursor reducer requests resync for gaps and epoch changes`() {
        val current = EventCursor("epoch-a", 8)

        assertEquals(CursorDisposition.RESYNC, classifyCursor(current, EventCursor("epoch-a", 10)))
        assertEquals(CursorDisposition.RESYNC, classifyCursor(current, EventCursor("epoch-b", 9)))
    }

    @Test
    fun `first authoritative event can establish a cursor`() {
        assertEquals(CursorDisposition.APPLY, classifyCursor(null, EventCursor("epoch-a", 41)))
    }

    @Test
    fun `older snapshots cannot replace state advanced by the event stream`() {
        val requestCursor = EventCursor("epoch-a", 8)
        val current = EventCursor("epoch-a", 10)

        assertEquals(false, shouldApplyNetworkSnapshot(current, requestCursor, EventCursor("epoch-a", 9)))
        assertEquals(true, shouldApplyNetworkSnapshot(current, requestCursor, EventCursor("epoch-a", 10)))
        assertEquals(true, shouldApplyNetworkSnapshot(current, requestCursor, EventCursor("epoch-a", 11)))
        assertEquals(false, shouldApplyNetworkSnapshot(current, requestCursor, null))
    }

    @Test
    fun `epoch-changing snapshots apply only when no event won the request race`() {
        val requestedAt = EventCursor("epoch-a", 8)

        assertEquals(
            true,
            shouldApplyNetworkSnapshot(requestedAt, requestedAt, EventCursor("epoch-b", 1)),
        )
        assertEquals(
            false,
            shouldApplyNetworkSnapshot(EventCursor("epoch-a", 9), requestedAt, EventCursor("epoch-b", 1)),
        )
    }
}
