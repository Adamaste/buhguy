package com.adamaste.buhguy.bankcollector

import android.content.Intent
import android.content.Context
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.text.InputType
import android.view.View
import android.os.Handler
import android.os.Looper
import com.adamaste.buhguy.bankcollector.notification.AlfaExtrasDiagnostic
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private val diagnosticHandler = Handler(Looper.getMainLooper())
    private var alfaRefresh: Runnable? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val preferences = AppPreferences(this)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        val status = TextView(this).apply {
            text = "Buhguy Bank Collector\nNotification access: ${if (packageName in NotificationManagerCompat.getEnabledListenerPackages(this@MainActivity)) "enabled" else "disabled"}"
        }
        layout.addView(status)
        layout.addView(Button(this).apply {
            text = "Open Notification Access settings"
            setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        })
        val server = EditText(this).apply { hint = "Server URL (HTTPS for production)"; setText(preferences.serverUrl()) }
        val source = EditText(this).apply { hint = "sourceKey"; setText(preferences.sourceKey()) }
        val packages = EditText(this).apply { hint = "Allowed bank package names, comma-separated"; setText(preferences.allowedPackages().joinToString(",")) }
        val credentialStore = DeviceCredentialStore(this)
        val credential = EditText(this).apply { hint = "Device credential (shown once when provisioned)"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        val credentialStatus = TextView(this).apply { text = if (credentialStore.isConfigured()) "Device credential configured" else "Device credential not configured" }
        layout.addView(server)
        layout.addView(source)
        layout.addView(packages)
        layout.addView(credential)
        layout.addView(credentialStatus)
        layout.addView(Button(this).apply {
            text = "Save configuration"
            setOnClickListener {
                preferences.save(server.text.toString(), source.text.toString(), packages.text.toString().split(',').toSet())
                if (credential.text.isNotBlank()) {
                    credentialStore.save(credential.text.toString())
                    credential.text?.clear()
                    credentialStatus.text = "Device credential configured"
                }
            }
        })
        layout.addView(Button(this).apply {
            text = "Clear device credential"
            setOnClickListener { credentialStore.clear(); credential.text?.clear(); credentialStatus.text = "Device credential not configured" }
        })
        layout.addView(Button(this).apply {
            text = "Test connection / deliver pending"
            setOnClickListener { com.adamaste.buhguy.bankcollector.delivery.AppRuntime.enqueue(this@MainActivity) }
        })
        val tbankDiagnosticToggle = CheckBox(this).apply {
            text = "One-time local T-Bank extra-field capture (debit card *7268 only)"
            isChecked = preferences.isTbankExtraDiagnosticsEnabled()
            setOnCheckedChangeListener { _, enabled ->
                if (enabled) preferences.startTbankExtraDiagnostics()
                else preferences.setTbankExtraDiagnosticsEnabled(false)
            }
        }
        layout.addView(tbankDiagnosticToggle)
        layout.addView(TextView(this).apply {
            text = "Off by default. Captures only a future purchase-shaped T-Bank notification carrying the confirmed *7268 mask. Only redacted field structure is saved on this device; extra fields are not added to the server event."
        })
        val tbankDiagnosticReport = TextView(this).apply {
            text = preferences.tbankExtraDiagnosticsReport().ifBlank { "No local T-Bank extra-field report captured" }
        }
        layout.addView(tbankDiagnosticReport)
        layout.addView(Button(this).apply {
            text = "Clear local T-Bank diagnostic report"
            setOnClickListener { preferences.clearTbankExtraDiagnosticsReport() }
        })
        layout.addView(TextView(this).apply {
            text = "Alfa extras: one-time local diagnostic. Only the Alfa app is inspected. Field values and notification keys never appear in this report or in the server event. The window closes after five minutes or three callbacks."
        })
        val alfaReport = TextView(this).apply { text = AlfaExtrasDiagnostic.display() }
        layout.addView(Button(this).apply {
            text = "Start one-time Alfa diagnostic"
            setOnClickListener { AlfaExtrasDiagnostic.arm(); alfaReport.text = AlfaExtrasDiagnostic.display() }
        })
        layout.addView(Button(this).apply {
            text = "Stop Alfa diagnostic and erase report"
            setOnClickListener { AlfaExtrasDiagnostic.clear(); alfaReport.text = AlfaExtrasDiagnostic.display() }
        })
        layout.addView(alfaReport)
        alfaRefresh = object : Runnable {
            override fun run() {
                alfaReport.text = AlfaExtrasDiagnostic.display()
                diagnosticHandler.postDelayed(this, 1000L)
            }
        }
        val pending = TextView(this).apply {
            tag = "diagnostics"
            text = "Pending events: loading...\nEvents held for review (content hidden): loading..."
        }
        layout.addView(pending)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                val pendingFlow = (application as BankCollectorApplication).database.outbox().pendingCountFlow()
                val heldFlow = (application as BankCollectorApplication).database.outbox().heldForReviewCountFlow()
                preferences.diagnosticChanges()
                    .combine(pendingFlow) { _, count -> count }
                    .combine(heldFlow) { pendingCount, heldCount -> pendingCount to heldCount }
                    .collect { (pendingCount, heldCount) ->
                        pending.text = preferences.diagnosticsSnapshot(pendingCount, heldCount).render()
                        tbankDiagnosticToggle.isChecked = preferences.isTbankExtraDiagnosticsEnabled()
                        tbankDiagnosticReport.text = preferences.tbankExtraDiagnosticsReport()
                            .ifBlank { "No local T-Bank extra-field report captured" }
                    }
            }
        }
        setContentView(scrollableScreen(this, layout))
    }

    override fun onResume() {
        super.onResume()
        alfaRefresh?.let(diagnosticHandler::post)
    }

    override fun onPause() {
        alfaRefresh?.let(diagnosticHandler::removeCallbacks)
        AlfaExtrasDiagnostic.clearFinishedReport()
        super.onPause()
    }
}

internal fun scrollableScreen(context: Context, content: View): ScrollView = ScrollView(context).apply {
    isFillViewport = true
    addView(content)
}
