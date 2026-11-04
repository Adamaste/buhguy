package com.adamaste.buhguy.bankcollector.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlfaOneShotNotificationDiagnosticsTest {
    @Test
    fun diagnosticsAreOffByDefaultAndIgnoreOtherPackages() {
        val session = session()
        assertFalse(session.state.value.active)
        assertFalse(session.capture(input(packageName = "com.other.bank"), nowElapsedMs = 10L))
        assertTrue(session.state.value.rows.isEmpty())

        session.start(nowElapsedMs = 10L)
        assertFalse(session.capture(input(packageName = "com.other.bank"), nowElapsedMs = 11L))
        assertTrue(session.state.value.active)
        assertTrue(session.state.value.rows.isEmpty())
    }

    @Test
    fun capturesOnlyApprovedMetadataAndHashesIdentifiersWithinSession() {
        val session = session()
        session.start(nowElapsedMs = 100L)

        assertTrue(
            session.capture(
                input(
                    extrasNames = listOf("android.title", "android.text", "android.title"),
                    notificationKey = "private-notification-key",
                    tag = "private-tag",
                    groupKey = "private-group",
                ),
                nowElapsedMs = 101L,
            ),
        )

        val row = session.state.value.rows.single()
        assertEquals(1, row.sequence)
        assertEquals(73, row.notificationId)
        assertEquals(1_800_000_000_000L, row.postTime)
        assertEquals("channel.purchase", row.channelId)
        assertEquals(listOf("android.text", "android.title"), row.extrasNames)
        assertTrue(row.notificationKeyHash != "private-notification-key")
        assertTrue(row.tagHash != "private-tag")
        assertTrue(row.groupKeyHash != "private-group")
        val rendered = renderAlfaDiagnosticState(session.state.value)
        assertFalse(rendered.contains("private-notification-key"))
        assertFalse(rendered.contains("private-tag"))
        assertFalse(rendered.contains("private-group"))
        assertFalse(rendered.contains("24.00"))
        assertFalse(rendered.contains("balance"))
    }

    @Test
    fun sameIdentifiersHashConsistentlyOnlyInsideOneSession() {
        val salts = mutableListOf(ByteArray(32) { 1 }, ByteArray(32) { 2 })
        val session = AlfaOneShotNotificationDiagnosticSession { salts.removeAt(0) }
        val sameInput = input(notificationKey = "key-1", tag = "tag-1", groupKey = "group-1")

        session.start(nowElapsedMs = 0L)
        session.capture(sameInput, nowElapsedMs = 1L)
        val first = session.state.value.rows.single()
        session.clear()

        session.start(nowElapsedMs = 2L)
        session.capture(sameInput, nowElapsedMs = 3L)
        val second = session.state.value.rows.single()

        assertNotEquals(first.notificationKeyHash, second.notificationKeyHash)
        assertNotEquals(first.tagHash, second.tagHash)
        assertNotEquals(first.groupKeyHash, second.groupKeyHash)
    }

    @Test
    fun repeatedIdentifiersCanBeComparedWithinOneSession() {
        val session = session()
        val sameInput = input(notificationKey = "key-1", tag = "tag-1", groupKey = "group-1")
        session.start(nowElapsedMs = 0L)
        session.capture(sameInput, nowElapsedMs = 1L)
        session.capture(sameInput, nowElapsedMs = 2L)

        val (first, second) = session.state.value.rows
        assertEquals(first.notificationKeyHash, second.notificationKeyHash)
        assertEquals(first.tagHash, second.tagHash)
        assertEquals(first.groupKeyHash, second.groupKeyHash)
    }

    @Test
    fun timeoutAutomaticallyStopsAndRejectsLateEvents() {
        val session = session()
        val sessionId = session.start(nowElapsedMs = 1_000L)
        session.capture(input(), nowElapsedMs = 1_001L)

        session.expire(sessionId, nowElapsedMs = 1_000L + ALFA_DIAGNOSTIC_TIMEOUT_MS - 1)
        assertTrue(session.state.value.active)
        session.expire(sessionId, nowElapsedMs = 1_000L + ALFA_DIAGNOSTIC_TIMEOUT_MS)

        assertFalse(session.state.value.active)
        assertEquals(1, session.state.value.rows.size)
        assertFalse(session.capture(input(), nowElapsedMs = 1_000L + ALFA_DIAGNOSTIC_TIMEOUT_MS + 1))
    }

    @Test
    fun eventLimitAutomaticallyStopsAtSix() {
        val session = session()
        session.start(nowElapsedMs = 0L)

        repeat(ALFA_DIAGNOSTIC_MAX_EVENTS) { index ->
            assertTrue(session.capture(input(notificationId = index), nowElapsedMs = index.toLong()))
        }

        assertFalse(session.state.value.active)
        assertEquals(ALFA_DIAGNOSTIC_MAX_EVENTS, session.state.value.rows.size)
        assertFalse(session.capture(input(notificationId = 99), nowElapsedMs = 99L))
        assertEquals(ALFA_DIAGNOSTIC_MAX_EVENTS, session.state.value.rows.size)
    }

    @Test
    fun missingTagAndGroupKeyAreRepresentedWithoutFailure() {
        val session = session()
        session.start(nowElapsedMs = 0L)

        assertTrue(session.capture(input(notificationKey = null, tag = null, groupKey = null), nowElapsedMs = 1L))

        val row = session.state.value.rows.single()
        assertNull(row.notificationKeyHash)
        assertNull(row.tagHash)
        assertNull(row.groupKeyHash)
        assertTrue(renderAlfaDiagnosticState(session.state.value).contains("<нет>"))
    }

    @Test
    fun manualStopAndClearKeepResultsOnlyUntilExplicitClear() {
        val session = session()
        session.start(nowElapsedMs = 0L)
        session.capture(input(), nowElapsedMs = 1L)
        session.stop()

        assertFalse(session.state.value.active)
        assertEquals(1, session.state.value.rows.size)
        session.clear()
        assertFalse(session.state.value.active)
        assertTrue(session.state.value.rows.isEmpty())
    }

    private fun session() = AlfaOneShotNotificationDiagnosticSession {
        ByteArray(32) { 7 }
    }

    private fun input(
        packageName: String = ALFA_NOTIFICATION_PACKAGE,
        notificationId: Int = 73,
        extrasNames: Collection<String> = listOf("android.title", "android.text"),
        notificationKey: String? = "key-1",
        tag: String? = "tag-1",
        groupKey: String? = "group-1",
    ) = AlfaNotificationDiagnosticInput(
        packageName = packageName,
        notificationId = notificationId,
        postTime = 1_800_000_000_000L,
        channelId = "channel.purchase",
        extrasNames = extrasNames,
        notificationKey = notificationKey,
        tag = tag,
        groupKey = groupKey,
    )
}
