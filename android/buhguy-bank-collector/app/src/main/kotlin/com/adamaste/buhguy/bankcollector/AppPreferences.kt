package com.adamaste.buhguy.bankcollector

import android.content.Context
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

class AppPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("collector-config", Context.MODE_PRIVATE)
    private val packageName = context.packageName
    fun sourceKey(): String = preferences.getString("sourceKey", "android-$packageName")!!
    fun allowedPackages(): Set<String> = preferences.getStringSet("allowedPackages", emptySet()) ?: emptySet()
    fun serverUrl(): String = preferences.getString("serverUrl", "")!!
    fun lastSuccessfulDelivery(): String = preferences.getString("lastSuccessfulDelivery", "never")!!
    fun lastSuccessfulDeliveryPackage(): String = preferences.getString("lastSuccessfulDeliveryPackage", "unknown")!!
    fun lastSuccessfulDeliveryEventPrefix(): String = preferences.getString("lastSuccessfulDeliveryEventPrefix", "unknown")!!
    fun lastSuccessfulDeliveryServerStatus(): String = preferences.getString("lastSuccessfulDeliveryServerStatus", "unknown")!!
    fun lastCaptureAt(): String = preferences.getString("lastCaptureAt", "never")!!
    fun lastCapturePackage(): String = preferences.getString("lastCapturePackage", "never")!!
    fun lastCaptureOutcome(): String = preferences.getString("lastCaptureOutcome", "never")!!
    fun lastCaptureEventPrefix(): String = preferences.getString("lastCaptureEventPrefix", "never")!!
    fun lastCallbackAt(): String = preferences.getString("lastCallbackAt", "never")!!
    fun lastCallbackPackage(): String = preferences.getString("lastCallbackPackage", "never")!!
    fun lastCallbackStage(): String = preferences.getString("lastCallbackStage", "never")!!
    fun lastListenerState(): String = preferences.getString("lastListenerState", "never")!!
    fun lastListenerStateAt(): String = preferences.getString("lastListenerStateAt", "never")!!
    fun isTbankExtraDiagnosticsEnabled(): Boolean = preferences.getBoolean(TBANK_EXTRA_DIAGNOSTICS_ENABLED, false)
    fun tbankExtraDiagnosticsReport(): String = preferences.getString(TBANK_EXTRA_DIAGNOSTICS_REPORT, "")!!
    fun save(serverUrl: String, sourceKey: String, allowedPackages: Set<String>) {
        preferences.edit().putString("serverUrl", serverUrl.trim()).putString("sourceKey", sourceKey.trim())
            .putStringSet("allowedPackages", allowedPackages.map(String::trim).filter(String::isNotEmpty).toSet()).apply()
    }

    fun markSuccessfulDelivery(
        timestamp: String,
        packageName: String = "unknown",
        eventPrefix: String = "unknown",
        serverStatus: String = "unknown",
    ) = preferences.edit()
        .putString("lastSuccessfulDelivery", timestamp)
        .putString("lastSuccessfulDeliveryPackage", packageName)
        .putString("lastSuccessfulDeliveryEventPrefix", eventPrefix)
        .putString("lastSuccessfulDeliveryServerStatus", serverStatus)
        .apply()

    fun markLastCapture(timestamp: String, packageName: String, outcome: String, eventPrefix: String) =
        preferences.edit()
            .putString("lastCaptureAt", timestamp)
            .putString("lastCapturePackage", packageName)
            .putString("lastCaptureOutcome", outcome)
            .putString("lastCaptureEventPrefix", eventPrefix)
            .apply()

    fun markLastCallback(timestamp: String, packageName: String, stage: String) =
        preferences.edit()
            .putString("lastCallbackAt", timestamp)
            .putString("lastCallbackPackage", packageName)
            .putString("lastCallbackStage", stage)
            .apply()

    fun markListenerState(timestamp: String, state: String) =
        preferences.edit()
            .putString("lastListenerState", state)
            .putString("lastListenerStateAt", timestamp)
            .apply()

    fun startTbankExtraDiagnostics() = preferences.edit()
        .putBoolean(TBANK_EXTRA_DIAGNOSTICS_ENABLED, true)
        .remove(TBANK_EXTRA_DIAGNOSTICS_REPORT)
        .apply()

    fun setTbankExtraDiagnosticsEnabled(enabled: Boolean) =
        preferences.edit().putBoolean(TBANK_EXTRA_DIAGNOSTICS_ENABLED, enabled).apply()

    fun completeTbankExtraDiagnostics(sanitizedReport: String) = preferences.edit()
        .putBoolean(TBANK_EXTRA_DIAGNOSTICS_ENABLED, false)
        .putString(TBANK_EXTRA_DIAGNOSTICS_REPORT, sanitizedReport)
        .apply()

    fun clearTbankExtraDiagnosticsReport() =
        preferences.edit().remove(TBANK_EXTRA_DIAGNOSTICS_REPORT).apply()

    fun diagnosticChanges(): Flow<Unit> = callbackFlow {
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == null || key in DIAGNOSTIC_KEYS) trySend(Unit).isSuccess
        }
        preferences.registerOnSharedPreferenceChangeListener(listener)
        trySend(Unit)
        awaitClose { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }

    companion object {
        private val DIAGNOSTIC_KEYS = setOf(
            "lastSuccessfulDelivery",
            "lastSuccessfulDeliveryPackage",
            "lastSuccessfulDeliveryEventPrefix",
            "lastSuccessfulDeliveryServerStatus",
            "lastCaptureAt",
            "lastCapturePackage",
            "lastCaptureOutcome",
            "lastCaptureEventPrefix",
            "lastCallbackAt",
            "lastCallbackPackage",
            "lastCallbackStage",
            "lastListenerState",
            "lastListenerStateAt",
            TBANK_EXTRA_DIAGNOSTICS_ENABLED,
            TBANK_EXTRA_DIAGNOSTICS_REPORT,
        )

        private const val TBANK_EXTRA_DIAGNOSTICS_ENABLED = "tbankExtraDiagnosticsEnabled"
        private const val TBANK_EXTRA_DIAGNOSTICS_REPORT = "tbankExtraDiagnosticsReport"
    }
}
