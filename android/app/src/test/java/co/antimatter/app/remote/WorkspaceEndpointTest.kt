package co.antimatter.app.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceEndpointTest {
    @Test
    fun `normalizes an HTTPS workspace base address`() {
        val endpoint = WorkspaceEndpoint.parse("  Studio  ", "https://EXAMPLE.com:8443/antimatter/").getOrThrow()

        assertEquals("Studio", endpoint.name)
        assertEquals("https://example.com:8443/antimatter", endpoint.baseUrl)
    }

    @Test
    fun `normalizes an IPv6 host with brackets`() {
        val endpoint = WorkspaceEndpoint.parse("Studio", "https://[2001:db8::1]:8443/remote/").getOrThrow()

        assertEquals("https://[2001:db8::1]:8443/remote", endpoint.baseUrl)
    }

    @Test
    fun `rejects cleartext and embedded credentials`() {
        assertTrue(WorkspaceEndpoint.parse("Studio", "http://example.com").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://user:secret@example.com").isFailure)
    }

    @Test
    fun `rejects incomplete or stateful URLs`() {
        assertTrue(WorkspaceEndpoint.parse("", "https://example.com").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "example.com").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://example.com?token=secret").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://example.com/#fragment").isFailure)
    }

    @Test
    fun `rejects invalid ports and ambiguous encoded paths`() {
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://example.com:0").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://example.com:65536").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://example.com/a/%2e%2e/b").isFailure)
        assertTrue(WorkspaceEndpoint.parse("Studio", "https://example.com/a%2fb").isFailure)
    }

    @Test
    fun `credential validates input and redacts logs`() {
        val credential = WorkspaceCredential.create("abcdefghijklmnopqrstuvwxyz012345").getOrThrow()

        assertEquals("WorkspaceCredential(<redacted>)", credential.toString())
        assertFalse(credential.toString().contains("abcdefghijklmnopqrstuvwxyz012345"))
        assertTrue(WorkspaceCredential.create("short").isFailure)
        assertTrue(WorkspaceCredential.create("abcdefghijklmnopqrstuvwxyz 012345").isFailure)
    }
}
