package com.adamaste.buhguy.bankcollector.notification

import com.adamaste.buhguy.bankcollector.model.BankNotificationEvent
import kotlinx.serialization.json.Json
import java.time.Instant

data class CapturedNotification(
    val sourceEventId: String,
    val packageName: String,
    val eventJson: String,
)

class NotificationCapture(private val mapper: NotificationEventMapper) {
    private val json = Json { encodeDefaults = true }

    fun capture(snapshot: NotificationSnapshot, capturedAt: Instant = Instant.now()): CapturedNotification? {
        if (SensitiveBankNotificationFilter.shouldReject(snapshot)) return null
        val event = mapper.map(snapshot, capturedAt) ?: return null
        return CapturedNotification(
            sourceEventId = event.sourceEventId,
            packageName = snapshot.packageName,
            eventJson = json.encodeToString(BankNotificationEvent.serializer(), event),
        )
    }
}
