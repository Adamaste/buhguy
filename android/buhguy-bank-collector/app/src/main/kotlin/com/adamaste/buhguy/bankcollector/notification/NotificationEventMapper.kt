package com.adamaste.buhguy.bankcollector.notification

import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.model.BankNotificationEvent
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant

data class NotificationSnapshot(
    val packageName: String,
    val notificationKey: String?,
    val notificationId: Int,
    val notificationTag: String?,
    val postTime: Long,
    val title: String?,
    val text: String?,
    val bigText: String?,
    val subText: String?,
)

class NotificationEventMapper(
    private val registry: BankProviderRegistry,
    private val sourceKey: String,
) {
    fun map(snapshot: NotificationSnapshot, capturedAt: Instant = Instant.now()): BankNotificationEvent? {
        val provider = registry.providerFor(snapshot.packageName) ?: return null
        val payload = linkedMapOf<String, String?>().apply {
            put("title", snapshot.title)
            put("text", snapshot.text)
            snapshot.bigText?.let { put("description", it) }
            snapshot.subText?.let { put("reference", it) }
        }.filterValues { it != null }
        return BankNotificationEvent(
            sourceKey = sourceKey,
            sourceEventId = deterministicSourceEventId(snapshot),
            observedAt = capturedAt.toString(),
            eventTime = Instant.ofEpochMilli(snapshot.postTime).toString(),
            payload = payload,
            ingestionMetadata = mapOf(
                "adapter" to "android-notification",
                "provider" to provider.providerKey,
                "deviceType" to "android",
                "schemaVersion" to "1",
            ),
        )
    }

    fun deterministicSourceEventId(snapshot: NotificationSnapshot): String {
        val identity = listOf(
            snapshot.packageName,
            snapshot.notificationKey.orEmpty(),
            snapshot.notificationId.toString(),
            snapshot.notificationTag.orEmpty(),
            snapshot.postTime.toString(),
        ).joinToString("\u0000")
        return MessageDigest.getInstance("SHA-256")
            .digest(identity.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
