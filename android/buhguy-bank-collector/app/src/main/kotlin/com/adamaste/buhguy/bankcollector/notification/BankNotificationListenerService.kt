package com.adamaste.buhguy.bankcollector.notification

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.adamaste.buhguy.bankcollector.AppPreferences
import com.adamaste.buhguy.bankcollector.BankCollectorApplication
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.outbox.OutboxEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant

class BankNotificationListenerService : NotificationListenerService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val preferences = AppPreferences(this)
        val mapper = NotificationEventMapper(BankProviderRegistry.fromPackageAllowlist(preferences.allowedPackages()), preferences.sourceKey())
        val captured = NotificationCapture(mapper).capture(sbn.toSnapshot(), Instant.now()) ?: return
        serviceScope.launch {
            (application as BankCollectorApplication).database.outbox().insert(
                OutboxEntity(sourceEventId = captured.sourceEventId, packageName = captured.packageName, eventJson = captured.eventJson),
            )
            com.adamaste.buhguy.bankcollector.delivery.AppRuntime.enqueue(this@BankNotificationListenerService)
        }
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun StatusBarNotification.toSnapshot(): NotificationSnapshot {
        val extras = notification.extras
        return NotificationSnapshot(
            packageName = packageName,
            notificationKey = key,
            notificationId = id,
            notificationTag = tag,
            postTime = postTime,
            title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.take(4096),
            text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.take(4096),
            bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.take(4096),
            subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.take(4096),
        )
    }
}
