package com.adamaste.buhguy.bankcollector

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.text.InputType
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
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
        val pending = TextView(this).apply { text = "Pending events: loading...\nLast successful delivery: ${preferences.lastSuccessfulDelivery()}" }
        layout.addView(pending)
        lifecycleScope.launch(Dispatchers.IO) {
            val count = (application as BankCollectorApplication).database.outbox().pendingCount()
            launch(Dispatchers.Main) {
                pending.text = listOf(
                    "Pending events: $count",
                    "Last successful delivery: ${preferences.lastSuccessfulDelivery()}",
                    "Last capture: ${preferences.lastCaptureOutcome()} ${preferences.lastCapturePackage()} ${preferences.lastCaptureEventPrefix()} at ${preferences.lastCaptureAt()}",
                    "Last callback: ${preferences.lastCallbackStage()} ${preferences.lastCallbackPackage()} at ${preferences.lastCallbackAt()}",
                    "Listener lifecycle: ${preferences.lastListenerState()} at ${preferences.lastListenerStateAt()}",
                    "Auth provisioning is separate.",
                ).joinToString("\n")
            }
        }
        setContentView(layout)
    }
}
