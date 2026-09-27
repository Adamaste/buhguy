package com.adamaste.buhguy.bankcollector

import com.adamaste.buhguy.bankcollector.notification.BankCaptureDiagnostics
import com.adamaste.buhguy.bankcollector.notification.BankCaptureLogEvent
import com.adamaste.buhguy.bankcollector.notification.BankCaptureOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BankCaptureDiagnosticsTest {
    @Test fun insertedRowIsReportedAsInserted() {
        assertEquals(BankCaptureOutcome.INSERTED, BankCaptureDiagnostics.insertOutcome(12L))
    }

    @Test fun ignoredInsertIsReportedAsDuplicate() {
        assertEquals(BankCaptureOutcome.DUPLICATE, BankCaptureDiagnostics.insertOutcome(-1L))
    }

    @Test fun roomInsertExceptionIsReportedAsError() {
        val message = BankCaptureDiagnostics.message(
            BankCaptureLogEvent(
                packageName = "com.yandex.bank",
                outcome = BankCaptureOutcome.ERROR,
                eventPrefix = "abcdef123456",
                stage = "room_insert",
                errorType = "SQLiteException",
            ),
        )

        assertTrue(message.contains("outcome=ERROR"))
        assertTrue(message.contains("stage=room_insert"))
        assertTrue(message.contains("error=SQLiteException"))
    }

    @Test fun capturedMessageContainsSafeMetadataOnly() {
        val message = BankCaptureDiagnostics.message(
            BankCaptureLogEvent(
                packageName = "com.yandex.bank",
                outcome = BankCaptureOutcome.CAPTURED,
                eventPrefix = "abcdef123456",
                postTime = 123456789L,
                notificationId = 42,
                hasTag = true,
            ),
        )

        assertTrue(message.contains("package=com.yandex.bank"))
        assertTrue(message.contains("outcome=CAPTURED"))
        assertTrue(message.contains("event=abcdef123456"))
        assertTrue(message.contains("notificationId=42"))
        assertTrue(message.contains("hasTag=true"))
        assertFalse(message.contains("Salary"))
        assertFalse(message.contains("100 RUB"))
        assertFalse(message.contains("Bearer"))
        assertFalse(message.contains("device credential"))
        assertFalse(message.contains("payload"))
        assertFalse(message.contains("eventJson"))
    }

    @Test fun sourceEventPrefixIsStableAndShort() {
        assertEquals("0123456789ab", BankCaptureDiagnostics.eventPrefix("0123456789abcdef"))
    }
}
