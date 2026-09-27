package com.adamaste.buhguy.bankcollector.notification

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.adamaste.buhguy.bankcollector.AppPreferences
import com.adamaste.buhguy.bankcollector.BankCollectorApplication
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.outbox.OutboxEntity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant

class BankNotificationListenerService : NotificationListenerService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val callbackAt = Instant.now().toString()
        BankCaptureDiagnostics.log(
            BankCaptureLogEvent(
                packageName = sbn.packageName,
                stage = "callback_entry",
                postTime = sbn.postTime,
                notificationId = sbn.id,
                hasTag = sbn.tag != null,
            ),
        )
        val preferences = AppPreferences(this)
        preferences.markLastCallback(callbackAt, sbn.packageName, "callback_entry")
        val registry = BankProviderRegistry.fromPackageAllowlist(preferences.allowedPackages())
        if (!registry.isAllowed(sbn.packageName)) {
            BankCaptureDiagnostics.log(
                BankCaptureLogEvent(packageName = sbn.packageName, stage = "filtered", reason = "not_allowed"),
            )
            preferences.markLastCallback(callbackAt, sbn.packageName, "filtered_not_allowed")
            return
        }
        val mapper = NotificationEventMapper(registry, preferences.sourceKey())
        val snapshot = sbn.toSnapshot()
        val captured = NotificationCapture(mapper).capture(snapshot, Instant.now())
        if (captured == null) {
            BankCaptureDiagnostics.log(
                BankCaptureLogEvent(packageName = sbn.packageName, stage = "filtered", reason = "capture_null"),
            )
            preferences.markLastCallback(callbackAt, sbn.packageName, "capture_null")
            return
        }
        val eventPrefix = BankCaptureDiagnostics.eventPrefix(captured.sourceEventId)
        BankCaptureDiagnostics.log(
            BankCaptureLogEvent(
                packageName = captured.packageName,
                outcome = BankCaptureOutcome.CAPTURED,
                eventPrefix = eventPrefix,
                postTime = snapshot.postTime,
                notificationId = snapshot.notificationId,
                hasTag = snapshot.notificationTag != null,
            ),
        )
        preferences.markLastCapture(callbackAt, captured.packageName, BankCaptureOutcome.CAPTURED.name, eventPrefix)
        serviceScope.launch {
            val rowId: Long
            try {
                rowId = (application as BankCollectorApplication).database.outbox().insert(
                    OutboxEntity(sourceEventId = captured.sourceEventId, packageName = captured.packageName, eventJson = captured.eventJson),
                )
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                BankCaptureDiagnostics.log(
                    BankCaptureLogEvent(
                        packageName = captured.packageName,
                        outcome = BankCaptureOutcome.ERROR,
                        eventPrefix = eventPrefix,
                        stage = BANK_CAPTURE_ROOM_INSERT_STAGE,
                        errorType = error::class.java.simpleName,
                    ),
                )
                preferences.markLastCapture(callbackAt, captured.packageName, BankCaptureOutcome.ERROR.name, eventPrefix)
                return@launch
            }
            val outcome = BankCaptureDiagnostics.insertOutcome(rowId)
            BankCaptureDiagnostics.log(
                BankCaptureLogEvent(
                    packageName = captured.packageName,
                    outcome = outcome,
                    eventPrefix = eventPrefix,
                    rowId = rowId.takeIf { outcome == BankCaptureOutcome.INSERTED },
                ),
            )
            preferences.markLastCapture(callbackAt, captured.packageName, outcome.name, eventPrefix)
            try {
                com.adamaste.buhguy.bankcollector.delivery.AppRuntime.enqueue(this@BankNotificationListenerService)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                BankCaptureDiagnostics.log(
                    BankCaptureLogEvent(
                        packageName = captured.packageName,
                        outcome = BankCaptureOutcome.ERROR,
                        eventPrefix = eventPrefix,
                        stage = BANK_CAPTURE_ENQUEUE_STAGE,
                        errorType = error::class.java.simpleName,
                    ),
                )
                throw error
            }
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        val timestamp = Instant.now().toString()
        BankCaptureDiagnostics.log(BankCaptureLogEvent(stage = "listener", listenerState = "connected"))
        AppPreferences(this).markListenerState(timestamp, "connected")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        val timestamp = Instant.now().toString()
        BankCaptureDiagnostics.log(BankCaptureLogEvent(stage = "listener", listenerState = "disconnected"))
        AppPreferences(this).markListenerState(timestamp, "disconnected")
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
