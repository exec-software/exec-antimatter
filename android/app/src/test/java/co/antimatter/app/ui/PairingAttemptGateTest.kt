package co.antimatter.app.ui

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairingAttemptGateTest {
    @Test
    fun `same or different second pairing is rejected until the first terminates`() {
        val gate = PairingAttemptGate()
        val first = gate.tryStart()

        assertNotNull(first)
        assertNull(gate.tryStart())

        gate.finish(first!!)
        assertNotNull(gate.tryStart())
    }

    @Test
    fun `late completion cannot release a newer pairing attempt`() {
        val gate = PairingAttemptGate()
        val first = gate.tryStart()!!
        gate.finish(first)
        val second = gate.tryStart()!!

        gate.finish(first)
        assertNull(gate.tryStart())

        gate.finish(second)
        assertNotNull(gate.tryStart())
    }
}
