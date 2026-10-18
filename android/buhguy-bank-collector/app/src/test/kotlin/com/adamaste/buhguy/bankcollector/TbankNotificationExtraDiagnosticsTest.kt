package com.adamaste.buhguy.bankcollector

import android.app.Notification
import android.os.Bundle
import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.notification.NotificationEventMapper
import com.adamaste.buhguy.bankcollector.notification.NotificationExtraSnapshot
import com.adamaste.buhguy.bankcollector.notification.NotificationSnapshot
import com.adamaste.buhguy.bankcollector.notification.TBANK_PROVIDER_PACKAGE
import com.adamaste.buhguy.bankcollector.notification.TbankNotificationExtraDiagnostics
import com.adamaste.buhguy.bankcollector.notification.TbankNotificationExtraReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TbankNotificationExtraDiagnosticsTest {
    @Test fun capturesStandardTextExtrasAndMessagingStyleFields() {
        val extras = Bundle().apply {
            putCharSequence(Notification.EXTRA_BIG_TEXT, "Покупка 785,19 ₽ Ашан *7268")
            putCharSequenceArray(Notification.EXTRA_TEXT_LINES, arrayOf("Списание по карте *7268"))
            putParcelableArray(
                Notification.EXTRA_MESSAGES,
                arrayOf(Bundle().apply { putCharSequence("text", "Доступно 12 345,67 ₽") }),
            )
        }

        val fields = TbankNotificationExtraReader.read(extras)
        assertEquals(listOf("Покупка 785,19 ₽ Ашан *7268"), fields.values.getValue("EXTRA_BIG_TEXT"))
        assertEquals(listOf("Списание по карте *7268"), fields.values.getValue("EXTRA_TEXT_LINES"))
        assertEquals(listOf("Доступно 12 345,67 ₽"), fields.values.getValue("EXTRA_MESSAGES"))
        assertTrue(fields.values.getValue("EXTRA_TITLE").isEmpty())
        assertTrue("EXTRA_BIG_TEXT" in fields.presentFields)
        assertFalse("EXTRA_TITLE" in fields.presentFields)
    }

    @Test fun reportKeepsOnlyStructureAndConfirmedMask() {
        val raw = "Покупка 785,19 ₽ Ашан карта *7268. Доступно 12 345,67 ₽; другая *1234"
        val report = TbankNotificationExtraDiagnostics.render(
            TBANK_PROVIDER_PACKAGE,
            NotificationExtraSnapshot(setOf("EXTRA_BIG_TEXT"), mapOf("EXTRA_BIG_TEXT" to listOf(raw))),
        )!!

        assertTrue(report.contains("EXTRA_BIG_TEXT=PRESENT"))
        assertTrue(report.contains("PURCHASE"))
        assertTrue(report.contains("<AMOUNT>"))
        assertTrue(report.contains("<BALANCE>"))
        assertTrue(report.contains("CARD_MASK(*7268)"))
        assertTrue(report.contains("CARD_MASK"))
        assertFalse(report.contains("785,19"))
        assertFalse(report.contains("12 345,67"))
        assertFalse(report.contains("Ашан"))
        assertFalse(report.contains("1234"))
    }

    @Test fun absentAndEmptyFieldsAreExplicitWithoutValues() {
        val report = TbankNotificationExtraDiagnostics.render(TBANK_PROVIDER_PACKAGE, NotificationExtraSnapshot(emptySet(), emptyMap()))!!

        assertTrue(report.contains("EXTRA_BIG_TEXT=ABSENT"))
        assertTrue(report.contains("EXTRA_MESSAGES=ABSENT"))
        assertFalse(report.contains("null"))
    }

    @Test fun captureIsRestrictedToConfirmedTbankDebitPurchaseShape() {
        assertTrue(TbankNotificationExtraDiagnostics.shouldCapture(TBANK_PROVIDER_PACKAGE, listOf("Покупка *7268")))
        assertFalse(TbankNotificationExtraDiagnostics.shouldCapture("com.other.bank", listOf("Покупка *7268")))
        assertFalse(TbankNotificationExtraDiagnostics.shouldCapture(TBANK_PROVIDER_PACKAGE, listOf("Перевод *7268")))
        assertFalse(TbankNotificationExtraDiagnostics.shouldCapture(TBANK_PROVIDER_PACKAGE, listOf("Покупка *1234")))
    }

    @Test fun reportCannotBeRenderedForAnotherProvider() {
        assertNull(TbankNotificationExtraDiagnostics.render("com.other.bank", NotificationExtraSnapshot(emptySet(), emptyMap())))
        assertNull(TbankNotificationExtraDiagnostics.readFailureReport("com.other.bank"))
    }

    @Test fun extraReadFailureHasOnlySafeMetadata() {
        val report = TbankNotificationExtraDiagnostics.readFailureReport(TBANK_PROVIDER_PACKAGE)!!
        assertTrue(report.contains("EXTRA_READ_STATUS=FAILED"))
        assertFalse(report.contains("message="))
        assertFalse(report.contains("7268"))
    }

    @Test fun additionalTextLinesStayOutOfTheExistingServerPayload() {
        val registry = BankProviderRegistry.fromPackageAllowlist(setOf(TBANK_PROVIDER_PACKAGE))
        val extraTextLine = "private extra line 987654"
        val report = TbankNotificationExtraDiagnostics.render(
            TBANK_PROVIDER_PACKAGE,
            TbankNotificationExtraReader.read(Bundle().apply {
                putCharSequenceArray(Notification.EXTRA_TEXT_LINES, arrayOf(extraTextLine))
            }),
        )!!
        val event = NotificationEventMapper(registry, "android-test").map(
            NotificationSnapshot(TBANK_PROVIDER_PACKAGE, "key", 1, null, 1L, "Покупка *7268", "785,19 ₽", null, null),
        )!!

        assertEquals(setOf("title", "text"), event.payload.keys)
        assertFalse(event.payload.values.any { it?.contains("EXTRA_MESSAGES") == true })
        assertFalse(event.payload.values.any { it?.contains(extraTextLine) == true })
        assertTrue(report.contains("EXTRA_TEXT_LINES=PRESENT"))
        assertFalse(report.contains(extraTextLine))
    }

    @Test fun currencyBalanceIsRedactedWhenItPrecedesTheBalanceLabel() {
        val report = TbankNotificationExtraDiagnostics.render(
            TBANK_PROVIDER_PACKAGE,
            NotificationExtraSnapshot(setOf("EXTRA_BIG_TEXT"), mapOf("EXTRA_BIG_TEXT" to listOf("12 345,67 RUB доступно"))),
        )!!

        assertTrue(report.contains("<BALANCE>"))
        assertFalse(report.contains("12 345,67"))
    }
}
