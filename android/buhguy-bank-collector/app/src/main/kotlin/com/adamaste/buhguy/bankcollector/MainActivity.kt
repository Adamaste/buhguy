package com.adamaste.buhguy.bankcollector

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
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
        layout.addView(server)
        layout.addView(source)
        layout.addView(packages)
        layout.addView(Button(this).apply {
            text = "Save configuration"
            setOnClickListener { preferences.save(server.text.toString(), source.text.toString(), packages.text.toString().split(',').toSet()) }
        })
        layout.addView(Button(this).apply {
            text = "Test connection / deliver pending"
            setOnClickListener { com.adamaste.buhguy.bankcollector.delivery.AppRuntime.enqueue(this@MainActivity) }
        })
        val pending = TextView(this).apply { text = "Pending events: loading...\nLast successful delivery: ${preferences.lastSuccessfulDelivery()}" }
        layout.addView(pending)
        lifecycleScope.launch(Dispatchers.IO) {
            val count = (application as BankCollectorApplication).database.outbox().pendingCount()
            launch(Dispatchers.Main) { pending.text = "Pending events: $count\nLast successful delivery: ${preferences.lastSuccessfulDelivery()}\nAuth provisioning is separate." }
        }
        setContentView(layout)
    }
}
