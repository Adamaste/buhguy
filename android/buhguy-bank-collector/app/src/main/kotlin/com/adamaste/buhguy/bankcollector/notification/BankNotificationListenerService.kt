package com.adamaste.buhguy.bankcollector.notification

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.adamaste.buhguy.bankcollector.AppPreferences
import com.adamaste.buhguy.bankcollector.BankCollectorApplication
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.config.YANDEX_BANK_PROVIDER
import com.adamaste.buhguy.bankcollector.config.YANDEX_PRO_TRANSPORT_PACKAGE
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
    private val lifecycleStore by lazy { NotificationLifecycleStore(this) }

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
        val channelId = sbn.notification.channelId
        val sourceMatch = registry.match(sbn.packageName, channelId)
        if (sourceMatch == null) {
            BankCaptureDiagnostics.log(
                BankCaptureLogEvent(
                    packageName = sbn.packageName,
                    stage = "filtered",
                    reason = if (sbn.packageName == YANDEX_PRO_TRANSPORT_PACKAGE && YANDEX_BANK_PROVIDER in preferences.allowedPackages()) {
                        "channel_not_allowed"
                    } else {
                        "not_allowed"
                    },
                ),
            )
            preferences.markLastCallback(callbackAt, sbn.packageName, "filtered")
            return
        }
        val mapper = NotificationEventMapper(registry, preferences.sourceKey())
        val snapshot = sbn.toSnapshot(channelId)
        if (sbn.packageName == "ru.alfabank.mobile.android") {
            try { AlfaExtrasDiagnostic.capture(sbn.packageName, sbn.key, sbn.notification.extras) }
            catch (_: Exception) { /* Optional local diagnostic must not affect normal collection. */ }
        }
        if (preferences.isTbankExtraDiagnosticsEnabled() &&
            TbankNotificationExtraDiagnostics.shouldCapture(
                snapshot.packageName,
                listOf(snapshot.title, snapshot.text, snapshot.bigText, snapshot.subText),
            )
        ) {
            val report = try {
                TbankNotificationExtraDiagnostics.render(
                    snapshot.packageName,
                    TbankNotificationExtraReader.read(sbn.notification.extras),
                )
            } catch (_: Exception) {
                TbankNotificationExtraDiagnostics.readFailureReport(snapshot.packageName)
            }
            if (report != null) {
                preferences.completeTbankExtraDiagnostics(report)
            }
        }
        if (sourceMatch.requiresClassifier) {
            val classification = try {
                YandexProFinancialClassifier().classify(snapshot)
            } catch (error: Exception) {
                BankCaptureDiagnostics.log(
                    BankCaptureLogEvent(
                        packageName = sbn.packageName,
                        stage = "classifier_error",
                        reason = error::class.java.simpleName,
                    ),
                )
                return
            }
            when (classification) {
                is YandexProClassification.Financial -> {
                    BankCaptureDiagnostics.log(
                        BankCaptureLogEvent(packageName = sbn.packageName, stage = "classifier_financial", reason = classification.type.name),
                    )
                }
                is YandexProClassification.StrongUnknown -> {
                    BankCaptureDiagnostics.log(
                        BankCaptureLogEvent(packageName = sbn.packageName, stage = "classifier_strong_unknown", reason = classification.reason.name),
                    )
                }
                is YandexProClassification.NonFinancial -> {
                    BankCaptureDiagnostics.log(
                        BankCaptureLogEvent(packageName = sbn.packageName, stage = "classifier_non_financial", reason = classification.reason.name),
                    )
                }
                is YandexProClassification.Unknown -> {
                    BankCaptureDiagnostics.log(
                        BankCaptureLogEvent(packageName = sbn.packageName, stage = "classifier_unknown", reason = classification.reason.name),
                    )
                }
            }
            if (yandexCaptureDecision(classification) == YandexCaptureDecision.DROP) return
        }
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

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        val preferences = AppPreferences(this)
        val registry = BankProviderRegistry.fromPackageAllowlist(preferences.allowedPackages())
        if (registry.match(sbn.packageName, sbn.notification.channelId) != null) {
            lifecycleStore.finishLifecycle(sbn.key)
        }
        super.onNotificationRemoved(sbn)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        val timestamp = Instant.now().toString()
        BankCaptureDiagnostics.log(BankCaptureLogEvent(stage = "listener", listenerState = "connected"))
        AppPreferences(this).markListenerState(timestamp, "connected")
        try {
            val preferences = AppPreferences(this)
            val registry = BankProviderRegistry.fromPackageAllowlist(preferences.allowedPackages())
            val activeNotifications = getActiveNotifications() ?: return
            val activeKeys = activeNotifications
                .filter { registry.match(it.packageName, it.notification.channelId) != null }
                .map { it.key }
            lifecycleStore.retainActiveNotificationKeys(activeKeys)
        } catch (_: Exception) {
            // A failed reconciliation must not discard persisted lifecycle IDs.
        }
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

    private fun StatusBarNotification.toSnapshot(channelId: String?): NotificationSnapshot {
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
            channelId = channelId,
            notificationLifecycleId = lifecycleStore.lifecycleId(key),
        )
    }
}
