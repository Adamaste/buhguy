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
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
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
        val pending = TextView(this).apply {
            tag = "diagnostics"
            text = "Pending events: loading..."
        }
        layout.addView(pending)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                val pendingFlow = (application as BankCollectorApplication).database.outbox().pendingCountFlow()
                preferences.diagnosticChanges()
                    .combine(pendingFlow) { _, count -> count }
                    .collect { count ->
                        pending.text = preferences.diagnosticsSnapshot(count).render()
                        tbankDiagnosticToggle.isChecked = preferences.isTbankExtraDiagnosticsEnabled()
                        tbankDiagnosticReport.text = preferences.tbankExtraDiagnosticsReport()
                            .ifBlank { "No local T-Bank extra-field report captured" }
                    }
            }
        }
        setContentView(scrollableScreen(this, layout))
    }
}

internal fun scrollableScreen(context: Context, content: View): ScrollView = ScrollView(context).apply {
    isFillViewport = true
    addView(content)
}
