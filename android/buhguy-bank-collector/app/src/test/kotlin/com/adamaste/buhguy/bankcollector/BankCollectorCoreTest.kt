package com.adamaste.buhguy.bankcollector

import com.adamaste.buhguy.bankcollector.config.BankProviderConfig
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.delivery.DeliveryDecision
import com.adamaste.buhguy.bankcollector.delivery.deliveryDecision
import com.adamaste.buhguy.bankcollector.notification.NotificationEventMapper
import com.adamaste.buhguy.bankcollector.notification.NotificationCapture
import com.adamaste.buhguy.bankcollector.notification.NotificationSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class BankCollectorCoreTest {
    private val registry = BankProviderRegistry(listOf(BankProviderConfig("demo", "Demo", setOf("com.demo.bank"))))
    private val mapper = NotificationEventMapper(registry, "android-demo")
    private val snapshot = NotificationSnapshot("com.demo.bank", "key", 7, "tag", 1000L, "Payment", "100 RUB", null, null)

    @Test fun unknownPackageIsIgnored() = assertEquals(null, mapper.map(snapshot.copy(packageName = "com.other.app")))

    @Test fun sameNotificationHasStableIdAndDifferentNotificationDoesNot() {
        assertEquals(mapper.deterministicSourceEventId(snapshot), mapper.deterministicSourceEventId(snapshot))
        assertNotEquals(mapper.deterministicSourceEventId(snapshot), mapper.deterministicSourceEventId(snapshot.copy(postTime = 2000L)))
    }

    @Test fun payloadContainsOnlyMinimizedFields() {
        val event = mapper.map(snapshot)!!
        assertEquals(setOf("title", "text"), event.payload.keys)
        assertEquals("android-notification", event.ingestionMetadata["adapter"])
        assertEquals("com.demo.bank", event.ingestionMetadata["sourcePackage"])
        assertEquals(null, event.ingestionMetadata["notificationChannel"])
    }

    @Test fun allowlistedNotificationIsCapturedAndRetryReusesSameEventId() {
        val capture = NotificationCapture(mapper)
        val first = capture.capture(snapshot)!!
        val retry = capture.capture(snapshot)!!
        assertEquals(first.sourceEventId, retry.sourceEventId)
        assertEquals(first.packageName, "com.demo.bank")
    }

    @Test fun yandexAliasUsesCanonicalProviderAndActualTransportIdentity() {
        val yandexRegistry = BankProviderRegistry.fromPackageAllowlist(setOf("com.yandex.bank"))
        val yandexMapper = NotificationEventMapper(yandexRegistry, "android-yandex")
        val yandexSnapshot = snapshot.copy(
            packageName = "ru.yandex.taximeter",
            channelId = "notification_channel_1",
        )

        val event = yandexMapper.map(yandexSnapshot)!!

        assertEquals("com.yandex.bank", event.ingestionMetadata["provider"])
        assertEquals("ru.yandex.taximeter", event.ingestionMetadata["sourcePackage"])
        assertEquals("notification_channel_1", event.ingestionMetadata["notificationChannel"])
        assertEquals(
            yandexMapper.deterministicSourceEventId(yandexSnapshot),
            yandexMapper.deterministicSourceEventId(yandexSnapshot.copy(channelId = "other")),
        )
    }

    @Test fun deliveryPolicyClassifiesOutcomes() {
        assertEquals(DeliveryDecision.Sent, deliveryDecision(201, false, "created"))
        assertEquals(DeliveryDecision.Sent, deliveryDecision(200, false, "duplicate"))
        assertEquals(DeliveryDecision.Retry, deliveryDecision(500, false))
        assertEquals(DeliveryDecision.Retry, deliveryDecision(null, true))
        assertEquals(DeliveryDecision.PermanentlyRejected("HTTP_400"), deliveryDecision(400, false))
        assertEquals(
            DeliveryDecision.PermanentlyRejected("SENSITIVE_AUTH_NOTIFICATION"),
            deliveryDecision(422, false, "rejected", "SENSITIVE_AUTH_NOTIFICATION"),
        )
        assertEquals(DeliveryDecision.PreservePending("AUTH_REQUIRED"), deliveryDecision(401, false))
        assertEquals(DeliveryDecision.PreservePending("SOURCE_MISMATCH"), deliveryDecision(403, false, serverCode = "SOURCE_MISMATCH"))
    }
}
