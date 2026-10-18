package com.adamaste.buhguy.bankcollector

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

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

    @Test fun diagnosticChangesProvideInitialRefreshTrigger() = runBlocking {
        val preferences = AppPreferences(context)
        withTimeout(2_000) { preferences.diagnosticChanges().first() }
    }

    @Test fun tbankExtraDiagnosticsAreOptInAndStoreOnlyTheSanitizedReport() {
        val preferences = AppPreferences(context)
        assertFalse(preferences.isTbankExtraDiagnosticsEnabled())

        preferences.startTbankExtraDiagnostics()
        assertTrue(preferences.isTbankExtraDiagnosticsEnabled())
        preferences.completeTbankExtraDiagnostics("EXTRA_BIG_TEXT=PRESENT(shape=PURCHASE <AMOUNT> CARD_MASK(*7268))")

        assertFalse(preferences.isTbankExtraDiagnosticsEnabled())
        assertEquals(
            "EXTRA_BIG_TEXT=PRESENT(shape=PURCHASE <AMOUNT> CARD_MASK(*7268))",
            preferences.tbankExtraDiagnosticsReport(),
        )
        assertFalse(context.getSharedPreferences("collector-config", android.content.Context.MODE_PRIVATE)
            .all.values.any { it.toString().contains("785,19") || it.toString().contains("Ашан") })
    }

    @Test fun startingANewTbankCaptureClearsThePreviousLocalReport() {
        val preferences = AppPreferences(context)
        preferences.completeTbankExtraDiagnostics("old sanitized report")

        preferences.startTbankExtraDiagnostics()

        assertTrue(preferences.isTbankExtraDiagnosticsEnabled())
        assertEquals("", preferences.tbankExtraDiagnosticsReport())
    }
}
