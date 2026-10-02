package com.adamaste.buhguy.bankcollector

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class AppPreferencesTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Before fun clearPreferences() {
        context.getSharedPreferences("collector-config", android.content.Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun successfulDeliveryKeepsTimestampAndSafeMetadata() {
        val preferences = AppPreferences(context)
        preferences.markSuccessfulDelivery("2026-10-02T10:00:00Z", "com.example.bank", "abcdef123456", "created")

        assertEquals("2026-10-02T10:00:00Z", preferences.lastSuccessfulDelivery())
        assertEquals("com.example.bank", preferences.lastSuccessfulDeliveryPackage())
        assertEquals("abcdef123456", preferences.lastSuccessfulDeliveryEventPrefix())
        assertEquals("created", preferences.lastSuccessfulDeliveryServerStatus())
        assertFalse(context.getSharedPreferences("collector-config", android.content.Context.MODE_PRIVATE).all.values.any { it == "abcdef1234567890" })
    }

    @Test fun duplicateDeliveryStatusIsStoredWithoutPayload() {
        val preferences = AppPreferences(context)
        preferences.markSuccessfulDelivery("2026-10-02T10:00:00Z", "com.example.bank", "0123456789ab", "duplicate")

        assertEquals("duplicate", preferences.lastSuccessfulDeliveryServerStatus())
        assertEquals("0123456789ab", preferences.lastSuccessfulDeliveryEventPrefix())
    }

    @Test fun legacyTimestampHasSafeMetadataDefaults() {
        context.getSharedPreferences("collector-config", android.content.Context.MODE_PRIVATE)
            .edit().putString("lastSuccessfulDelivery", "legacy-time").commit()

        val preferences = AppPreferences(context)
        assertEquals("legacy-time", preferences.lastSuccessfulDelivery())
        assertEquals("unknown", preferences.lastSuccessfulDeliveryPackage())
        assertEquals("unknown", preferences.lastSuccessfulDeliveryEventPrefix())
        assertEquals("unknown", preferences.lastSuccessfulDeliveryServerStatus())
    }

    @Test fun diagnosticChangesProvideInitialAndSubsequentRefreshTriggers() = runBlocking {
        val preferences = AppPreferences(context)
        withTimeout(2_000) { preferences.diagnosticChanges().first() }

        val changed = async(start = CoroutineStart.UNDISPATCHED) {
            withTimeout(2_000) { preferences.diagnosticChanges().drop(1).first() }
        }
        preferences.markLastCapture("time", "com.example.bank", "INSERTED", "abcdef123456")
        shadowOf(Looper.getMainLooper()).idle()
        changed.await()
    }
}
