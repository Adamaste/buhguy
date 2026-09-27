package com.adamaste.buhguy.bankcollector

import com.adamaste.buhguy.bankcollector.notification.NotificationSnapshot
import com.adamaste.buhguy.bankcollector.notification.YandexFinancialType
import com.adamaste.buhguy.bankcollector.notification.YandexProClassification
import com.adamaste.buhguy.bankcollector.notification.YandexProFinancialClassifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class YandexProFinancialClassifierTest {
    private val classifier = YandexProFinancialClassifier()

    private fun snapshot(
        title: String? = "ТЕСТОВЫЙ МАГАЗИН",
        text: String? = "Покупка на 123.45 RUB, карта *0000. Доступно 999.99 RUB",
        bigText: String? = null,
    ) = NotificationSnapshot(
        packageName = "ru.yandex.taximeter",
        notificationKey = "safe-test-key",
        notificationId = 1,
        notificationTag = null,
        postTime = 1L,
        title = title,
        text = text,
        bigText = bigText,
        subText = null,
        channelId = "notification_channel_1",
    )

    @Test fun purchaseVariantsAreFinancial() {
        assertEquals(YandexFinancialType.PURCHASE, (classifier.classify(snapshot()) as YandexProClassification.Financial).type)
        assertEquals(YandexFinancialType.PURCHASE, (classifier.classify(snapshot(text = "Покупка на 123.45 RUB, карта *0000")) as YandexProClassification.Financial).type)
        assertEquals(YandexFinancialType.PURCHASE, (classifier.classify(snapshot(text = "Покупка на 123.45 RUB\nДоступно 999.99 RUB")) as YandexProClassification.Financial).type)
    }

    @Test fun incomingTransferVariantsAreFinancial() {
        val first = snapshot(title = "Входящий перевод", text = "Пополнение на 123.45 RUB")
        val second = snapshot(title = "Входящий перевод", text = "Пополнение на 123.45 RUB. ТЕСТОВЫЙ ОТПРАВИТЕЛЬ")
        val third = snapshot(title = "Входящий перевод", text = "Пополнение на 123.45 RUB\n01.01")

        assertEquals(YandexFinancialType.INCOMING_TRANSFER, (classifier.classify(first) as YandexProClassification.Financial).type)
        assertEquals(YandexFinancialType.INCOMING_TRANSFER, (classifier.classify(second) as YandexProClassification.Financial).type)
        assertEquals(YandexFinancialType.INCOMING_TRANSFER, (classifier.classify(third) as YandexProClassification.Financial).type)
    }

    @Test fun genericNotificationsAreNonFinancial() {
        val result = classifier.classify(snapshot(title = "Сервис", text = "Доступно новое обновление"))

        assertTrue(result is YandexProClassification.NonFinancial)
    }

    @Test fun partialOrUnsupportedFinancialContentIsUnknown() {
        assertTrue(classifier.classify(snapshot(title = "Событие", text = "123.45 RUB")) is YandexProClassification.Unknown)
        assertTrue(classifier.classify(snapshot(title = "Покупка", text = "Покупка на RUB")) is YandexProClassification.Unknown)
        assertTrue(classifier.classify(snapshot(title = "Входящий перевод", text = "Пополнение на 123.45 USD")) is YandexProClassification.Unknown)
        assertTrue(classifier.classify(snapshot(title = "Перевод", text = "Перевод на 123.45 RUB")) is YandexProClassification.Unknown)
        assertTrue(classifier.classify(snapshot(title = null, text = null)) is YandexProClassification.Unknown)
    }

    @Test fun bigTextIsPreferredOverText() {
        val result = classifier.classify(snapshot(text = "Сервисное сообщение", bigText = "Покупка на 123.45 RUB"))

        assertEquals(YandexFinancialType.PURCHASE, (result as YandexProClassification.Financial).type)
    }

    @Test fun whitespaceAndNewlinesDoNotChangeClassification() {
        val result = classifier.classify(snapshot(text = "  Покупка   на\n123.45   RUB  "))

        assertEquals(YandexFinancialType.PURCHASE, (result as YandexProClassification.Financial).type)
    }

    @Test fun diagnosticsDoNotContainContent() {
        val result = classifier.classify(snapshot())
        val reason = when (result) {
            is YandexProClassification.Financial -> result.type.name
            is YandexProClassification.NonFinancial -> result.reason.name
            is YandexProClassification.Unknown -> result.reason.name
        }

        assertFalse(reason.contains("123.45"))
        assertFalse(reason.contains("ТЕСТОВЫЙ"))
        assertFalse(reason.contains("0000"))
    }
}
