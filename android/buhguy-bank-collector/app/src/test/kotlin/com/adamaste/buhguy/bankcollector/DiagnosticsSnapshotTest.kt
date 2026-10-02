package com.adamaste.buhguy.bankcollector

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticsSnapshotTest {
    @Test fun renderingContainsSafeLiveFieldsOnly() {
        val rendered = DiagnosticsSnapshot(
            pendingCount = 2,
            lastSuccessfulDeliveryAt = "time",
            lastSuccessfulDeliveryPackage = "com.example.bank",
            lastSuccessfulDeliveryEventPrefix = "abcdef123456",
            lastSuccessfulDeliveryServerStatus = "created",
            lastCaptureOutcome = "CAPTURED",
            lastCapturePackage = "com.example.bank",
            lastCaptureEventPrefix = "abcdef123456",
            lastCaptureAt = "time",
            lastCallbackStage = "callback_entry",
            lastCallbackPackage = "com.example.bank",
            lastCallbackAt = "time",
            listenerState = "connected",
            listenerStateAt = "time",
        ).render()

        assertTrue(rendered.contains("created com.example.bank abcdef123456"))
        assertTrue(rendered.contains("Pending events: 2"))
        assertFalse(rendered.contains("full-source-event-id"))
        assertFalse(rendered.contains("notification text"))
        assertFalse(rendered.contains("payload"))
        assertFalse(rendered.contains("credential"))
    }
}
