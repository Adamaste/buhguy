package com.adamaste.buhguy.bankcollector

import androidx.test.core.app.ApplicationProvider
import com.adamaste.buhguy.bankcollector.config.BankProviderConfig
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.notification.NotificationEventMapper
import com.adamaste.buhguy.bankcollector.notification.NotificationLifecycleStore
import com.adamaste.buhguy.bankcollector.notification.NotificationSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.spec.SecretKeySpec

@RunWith(RobolectricTestRunner::class)
class NotificationLifecycleStoreTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "HmacSHA256")

    @Test fun updatesAndRedeliveryReuseOpaqueLifecycleIdUntilRemoval() {
        context.getSharedPreferences(NotificationLifecycleStore.PREFERENCES_NAME, 0).edit().clear().commit()
        val store = NotificationLifecycleStore(context) { key }
        val rawKey = "0|ru.alfabank.mobile.android|17|private-tag"
        val first = store.lifecycleId(rawKey)
        val update = store.lifecycleId(rawKey)
        assertNotNull(first)
        assertEquals(first, update)
        assertFalse(context.getSharedPreferences(NotificationLifecycleStore.PREFERENCES_NAME, 0).all.keys.any { it.contains(rawKey) })

        store.finishLifecycle(rawKey)
        val nextPosting = store.lifecycleId(rawKey)
        assertNotNull(nextPosting)
        assertNotEquals(first, nextPosting)
    }

    @Test fun reconnectReconciliationKeepsActiveLifecycleAndDropsOnlyStaleOnes() {
        context.getSharedPreferences(NotificationLifecycleStore.PREFERENCES_NAME, 0).edit().clear().commit()
        val store = NotificationLifecycleStore(context) { key }
        val activeKey = "0|ru.alfabank.mobile.android|21|active-tag"
        val staleKey = "0|ru.alfabank.mobile.android|22|stale-tag"
        val activeId = store.lifecycleId(activeKey)
        val staleId = store.lifecycleId(staleKey)

        store.retainActiveNotificationKeys(listOf(activeKey))

        assertEquals(activeId, store.lifecycleId(activeKey))
        val newStaleLifecycleId = store.lifecycleId(staleKey)
        assertNotEquals(staleId, newStaleLifecycleId)
    }

    @Test fun mapperSendsOnlyOpaqueLifecycleIdAndKeepsPerPostRetryIdentity() {
        val registry = BankProviderRegistry(listOf(BankProviderConfig("ru.alfabank.mobile.android", "Alfa", setOf("ru.alfabank.mobile.android"))))
        val mapper = NotificationEventMapper(registry, "android-test")
        val rawKey = "0|ru.alfabank.mobile.android|17|private-tag"
        val id = UUID.randomUUID().toString()
        val snapshot = NotificationSnapshot(
            "ru.alfabank.mobile.android", rawKey, 17, "private-tag", 1000L,
            "- 17 ₽. Тройка", "Тройка: 17,00 ₽; •• 5580", "Тройка: 17,00 ₽; •• 5580", null,
            "AlfaBank", id,
        )
        val event = mapper.map(snapshot)!!
        assertEquals(id, event.ingestionMetadata["notificationLifecycleId"])
        assertFalse(event.payload.values.any { it?.contains(rawKey) == true })
        assertFalse(event.ingestionMetadata.values.any { it?.contains(rawKey) == true })
        val legacyIdentity = listOf(snapshot.packageName, rawKey, snapshot.notificationId.toString(),
            snapshot.notificationTag.orEmpty(), snapshot.postTime.toString()).joinToString("\u0000")
        val legacySourceEventId = MessageDigest.getInstance("SHA-256")
            .digest(legacyIdentity.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        assertEquals(legacySourceEventId, event.sourceEventId)
        assertEquals(event.sourceEventId, mapper.map(snapshot.copy(notificationLifecycleId = id))!!.sourceEventId)
        assertNotEquals(event.sourceEventId, mapper.map(snapshot.copy(postTime = 2000L))!!.sourceEventId)
    }
}
