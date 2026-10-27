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
    val channelId: String? = null,
    val notificationLifecycleId: String? = null,
)

class NotificationEventMapper(
    private val registry: BankProviderRegistry,
    private val sourceKey: String,
) {
    fun map(snapshot: NotificationSnapshot, capturedAt: Instant = Instant.now()): BankNotificationEvent? {
        val provider = registry.match(snapshot.packageName, snapshot.channelId)?.provider ?: return null
        val payload = linkedMapOf<String, String?>().apply {
            put("title", snapshot.title)
            put("text", snapshot.text)
            snapshot.bigText?.let { put("description", it) }
            snapshot.subText?.let { put("reference", it) }
        }.filterValues { it != null }
        val ingestionMetadata = linkedMapOf<String, String?>().apply {
            put("adapter", "android-notification")
            put("provider", provider.providerKey)
            put("deviceType", "android")
            put("schemaVersion", "1")
            put("sourcePackage", snapshot.packageName)
            snapshot.channelId?.takeIf { it.isNotBlank() }?.let { put("notificationChannel", it) }
            snapshot.notificationLifecycleId?.takeIf { it.isNotBlank() }?.let { put("notificationLifecycleId", it) }
        }
        return BankNotificationEvent(
            sourceKey = sourceKey,
            sourceEventId = deterministicSourceEventId(snapshot),
            observedAt = capturedAt.toString(),
            eventTime = Instant.ofEpochMilli(snapshot.postTime).toString(),
            payload = payload,
            ingestionMetadata = ingestionMetadata,
        )
    }

    fun deterministicSourceEventId(snapshot: NotificationSnapshot): String {
        val identity = listOf(
            snapshot.packageName,
            // Preserve pre-lifecycle event IDs for existing providers; only the digest leaves this process.
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
