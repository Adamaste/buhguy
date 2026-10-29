package com.adamaste.buhguy.bankcollector

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DiagnosticsSnapshotTest {
    @Test fun renderingContainsSafeLiveFieldsOnly() {
        val rendered = DiagnosticsSnapshot(
            pendingCount = 2,
            heldForReviewCount = 1,
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
        assertTrue(rendered.contains("Events held for review (content hidden): 1"))
        assertFalse(rendered.contains("full-source-event-id"))
        assertFalse(rendered.contains("notification text"))
        assertFalse(rendered.contains("payload"))
        assertFalse(rendered.contains("credential"))
    }

    @Test fun snapshotReadsUpdatedPreferencesWithoutActivityRecreation() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val preferences = AppPreferences(context)
        preferences.markLastCapture("time-1", "com.example.one", "CAPTURED", "111111111111")
        assertTrue(preferences.diagnosticsSnapshot(0, 0).render().contains("com.example.one"))
        preferences.markLastCapture("time-2", "com.example.two", "INSERTED", "222222222222")
        val rendered = preferences.diagnosticsSnapshot(3, 2).render()
        assertTrue(rendered.contains("Pending events: 3"))
        assertTrue(rendered.contains("Events held for review (content hidden): 2"))
        assertTrue(rendered.contains("INSERTED com.example.two 222222222222"))
    }
}
