package com.adamaste.buhguy.bankcollector

import com.adamaste.buhguy.bankcollector.config.BankProviderConfig
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.notification.BankCaptureDiagnostics
import com.adamaste.buhguy.bankcollector.notification.BankCaptureLogEvent
import com.adamaste.buhguy.bankcollector.notification.BankCaptureOutcome
import com.adamaste.buhguy.bankcollector.notification.NotificationCapture
import com.adamaste.buhguy.bankcollector.notification.NotificationEventMapper
import com.adamaste.buhguy.bankcollector.notification.NotificationSnapshot
import com.adamaste.buhguy.bankcollector.notification.SensitiveBankNotificationFilter
import com.adamaste.buhguy.bankcollector.notification.StoredEventScreening
import com.adamaste.buhguy.bankcollector.model.OutboxStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveBankNotificationFilterTest {
    private val registry = BankProviderRegistry(listOf(BankProviderConfig("alfa", "Alfa", setOf("ru.alfabank.mobile.android"))))
    private val mapper = NotificationEventMapper(registry, "android-test")

    @Test fun rejectsSmsLikeConfirmationCodeWithoutReturningSourceText() {
        val syntheticCodeNotice = "Ваш код подтверждения: 000000. Никому не сообщайте этот код."
        val snapshot = snapshot(text = syntheticCodeNotice)

        assertTrue(SensitiveBankNotificationFilter.shouldReject(snapshot))
        assertNull(NotificationCapture(mapper).capture(snapshot))
        val safeLog = BankCaptureDiagnostics.message(
            BankCaptureLogEvent(packageName = snapshot.packageName, outcome = BankCaptureOutcome.SENSITIVE_AUTH_REJECTED, stage = "pre_outbox_filter", reason = "authorization_code_content"),
        )
        assertFalse(safeLog.contains("000000"))
        assertFalse(safeLog.contains("подтверждения"))
    }

    @Test fun rejectsNotificationCombiningAnOperationWithAnAuthorizationCode() {
        val snapshot = snapshot(
            title = "Payment 350 RUB. Sample shop",
            text = "Operation details. One-time password: 000000",
        )
        assertTrue(SensitiveBankNotificationFilter.shouldReject(snapshot))
        assertNull(NotificationCapture(mapper).capture(snapshot))
    }

    @Test fun catchesSeparatedAuthorizationMessageAndCodeFields() {
        val snapshot = snapshot(title = "Сообщение авторизации", subText = "Введите код")
        assertTrue(SensitiveBankNotificationFilter.shouldReject(snapshot))
    }

    @Test fun rejectsAStandaloneShortNumericCodeField() {
        assertTrue(SensitiveBankNotificationFilter.shouldReject(snapshot(title = "Bank", text = "000000")))
    }

    @Test fun preSendScreenRejectsPreviouslyQueuedSensitiveEventsWithoutExposingText() {
        val syntheticOtp = "000000"
        val queued = """{"sourceKey":"android-test","sourceEventId":"safe-hash","observedAt":"2026-10-29T10:00:00Z","eventTime":"2026-10-29T09:59:00Z","payload":{"title":"Purchase 350 RUB","text":"Confirmation code: $syntheticOtp"},"ingestionMetadata":{"adapter":"android-notification"}}"""
        assertTrue(SensitiveBankNotificationFilter.screenStoredEvent(queued) == StoredEventScreening.SENSITIVE_AUTH)
    }

    @Test fun preSendScreenPreservesOrdinaryStructuredAmountsAndTransfers() {
        val queued = """{"sourceKey":"android-test","sourceEventId":"safe-hash","observedAt":"2026-10-29T10:00:00Z","payload":{"title":"Transfer 10000 RUB","amount":"10000","direction":"DEBIT"},"ingestionMetadata":{"adapter":"android-notification"}}"""
        assertTrue(SensitiveBankNotificationFilter.screenStoredEvent(queued) == StoredEventScreening.SAFE)
    }

    @Test fun preSendScreenFailsClosedOnUnreadableStoredEnvelope() {
        assertTrue(SensitiveBankNotificationFilter.screenStoredEvent("not-json") == StoredEventScreening.UNREADABLE)
        assertEquals("HELD_FOR_REVIEW", OutboxStatus.HELD_FOR_REVIEW.name)
    }

    @Test fun catchesUnicodeAndZeroWidthObfuscation() {
        val snapshot = snapshot(text = "ＯＮＥ ＴＩＭＥ\u200B ＰＡＳＳＷＯＲＤ 000000")
        assertTrue(SensitiveBankNotificationFilter.shouldReject(snapshot))
    }

    @Test fun allowsOrdinaryCardPurchaseAndKeepsExistingMappedPayload() {
        val snapshot = snapshot(
            title = "Purchase 350 RUB. Sample shop",
            text = "Sample shop: 350.00 RUB; card ending 0000",
        )
        assertFalse(SensitiveBankNotificationFilter.shouldReject(snapshot))
        val captured = NotificationCapture(mapper).capture(snapshot)
        assertNotNull(captured)
        assertTrue(captured!!.eventJson.contains("\"title\":\"Purchase 350 RUB. Sample shop\""))
        assertTrue(captured.eventJson.contains("\"text\":\"Sample shop: 350.00 RUB; card ending 0000\""))
    }

    @Test fun allowsTransfersAndNonAuthorizationOperationReferences() {
        assertFalse(SensitiveBankNotificationFilter.shouldReject(snapshot(title = "Transfer 125 RUB", text = "To recipient; operation code 123456")))
        assertFalse(SensitiveBankNotificationFilter.shouldReject(snapshot(title = "Refund 17 RUB", text = "Returned to account")))
        assertFalse(SensitiveBankNotificationFilter.shouldReject(snapshot(title = "Other -16 RUB", text = "Balance 1,250 RUB")))
    }

    private fun snapshot(
        title: String? = "Bank notification",
        text: String? = null,
        bigText: String? = null,
        subText: String? = null,
    ) = NotificationSnapshot(
        packageName = "ru.alfabank.mobile.android",
        notificationKey = "test-key",
        notificationId = 1,
        notificationTag = null,
        postTime = 1L,
        title = title,
        text = text,
        bigText = bigText,
        subText = subText,
        notificationLifecycleId = "00000000-0000-4000-8000-000000000000",
    )
}
