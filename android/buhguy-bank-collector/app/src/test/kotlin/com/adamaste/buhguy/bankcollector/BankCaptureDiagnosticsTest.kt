package com.adamaste.buhguy.bankcollector

import com.adamaste.buhguy.bankcollector.notification.BankCaptureDiagnostics
import com.adamaste.buhguy.bankcollector.notification.BANK_CAPTURE_ENQUEUE_STAGE
import com.adamaste.buhguy.bankcollector.notification.BANK_CAPTURE_ROOM_INSERT_STAGE
import com.adamaste.buhguy.bankcollector.notification.BankCaptureLogEvent
import com.adamaste.buhguy.bankcollector.notification.BankCaptureOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BankCaptureDiagnosticsTest {
    @Test fun callbackEntryContainsSafeMetadataWithoutPrefix() {
        val message = BankCaptureDiagnostics.message(
            BankCaptureLogEvent(packageName = "com.yandex.bank", stage = "callback_entry", postTime = 123L, notificationId = 42, hasTag = true),
        )
        assertTrue(message.contains("stage=callback_entry"))
        assertTrue(message.contains("package=com.yandex.bank"))
        assertTrue(message.contains("postTime=123"))
        assertFalse(message.contains("event="))
    }

    @Test fun filteredStagesAreExplicitAndSafe() {
        val notAllowed = BankCaptureDiagnostics.message(BankCaptureLogEvent(packageName = "com.other", stage = "filtered", reason = "not_allowed"))
        val captureNull = BankCaptureDiagnostics.message(BankCaptureLogEvent(packageName = "com.yandex.bank", stage = "filtered", reason = "capture_null"))
        assertTrue(notAllowed.contains("reason=not_allowed"))
        assertTrue(captureNull.contains("reason=capture_null"))
        assertFalse(captureNull.contains("title"))
        assertFalse(captureNull.contains("text"))
    }

    @Test fun listenerLifecycleIsSafe() {
        val connected = BankCaptureDiagnostics.message(BankCaptureLogEvent(stage = "listener", listenerState = "connected"))
        val disconnected = BankCaptureDiagnostics.message(BankCaptureLogEvent(stage = "listener", listenerState = "disconnected"))
        assertEquals("stage=listener state=connected", connected)
        assertEquals("stage=listener state=disconnected", disconnected)
    }

    @Test fun insertedDuplicateAndErrorOutcomesRemainSupported() {
        assertEquals(BankCaptureOutcome.INSERTED, BankCaptureDiagnostics.insertOutcome(12L))
        assertEquals(BankCaptureOutcome.DUPLICATE, BankCaptureDiagnostics.insertOutcome(-1L))
        val error = BankCaptureDiagnostics.message(BankCaptureLogEvent(packageName = "com.yandex.bank", outcome = BankCaptureOutcome.ERROR, stage = BANK_CAPTURE_ROOM_INSERT_STAGE, errorType = "SQLiteException"))
        assertTrue(error.contains("stage=$BANK_CAPTURE_ROOM_INSERT_STAGE"))
        assertTrue(error.contains("error=SQLiteException"))
    }

    @Test fun enqueueFailureIsNotReportedAsRoomInsertFailure() {
        val error = BankCaptureDiagnostics.message(
            BankCaptureLogEvent(packageName = "com.yandex.bank", outcome = BankCaptureOutcome.ERROR, stage = BANK_CAPTURE_ENQUEUE_STAGE, errorType = "IllegalStateException"),
        )
        assertTrue(error.contains("stage=$BANK_CAPTURE_ENQUEUE_STAGE"))
        assertFalse(error.contains("stage=$BANK_CAPTURE_ROOM_INSERT_STAGE"))
    }

    @Test fun diagnosticsNeverContainNotificationContentOrSecrets() {
        val message = BankCaptureDiagnostics.message(
            BankCaptureLogEvent(packageName = "com.yandex.bank", outcome = BankCaptureOutcome.CAPTURED, eventPrefix = "abcdef123456", notificationId = 42),
        )
        assertFalse(message.contains("Salary"))
        assertFalse(message.contains("100 RUB"))
        assertFalse(message.contains("Bearer"))
        assertFalse(message.contains("credential"))
        assertFalse(message.contains("payload"))
        assertFalse(message.contains("eventJson"))
    }

    @Test fun sourceEventPrefixIsStableAndShort() {
        assertEquals("0123456789ab", BankCaptureDiagnostics.eventPrefix("0123456789abcdef"))
    }
}
