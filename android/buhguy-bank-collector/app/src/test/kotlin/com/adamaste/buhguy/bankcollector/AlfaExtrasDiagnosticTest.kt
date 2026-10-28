package com.adamaste.buhguy.bankcollector

import android.app.Notification
import android.os.Bundle
import com.adamaste.buhguy.bankcollector.notification.AlfaExtrasDiagnostic
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AlfaExtrasDiagnosticTest {
    @After fun clear() = AlfaExtrasDiagnostic.clear()

    @Test fun requiresManualArmAndExactAlfaPackage() {
        val extras = Bundle().apply { putString(Notification.EXTRA_TEXT, "оплата 26,00 ₽") }
        AlfaExtrasDiagnostic.capture("ru.alfabank.mobile.android", "key", extras, 100L)
        assertFalse(AlfaExtrasDiagnostic.display(101L).contains("Notification 1"))
        AlfaExtrasDiagnostic.arm(100L)
        AlfaExtrasDiagnostic.capture("com.other.bank", "key", extras, 101L)
        assertFalse(AlfaExtrasDiagnostic.display(102L).contains("Notification 1"))
    }

    @Test fun reportsSameAndDifferentKeysWithoutExposingKeysOrValues() {
        val privateText = "Пятёрочка 26,00 ₽; •• 5580; account 123456789; token secret-123"
        val extras = Bundle().apply {
            putString(Notification.EXTRA_TEXT, privateText)
            putString("com.alfa.transactionId", "private-bank-operation-123")
            putLong("com.alfa.amount", 2600L)
        }
        AlfaExtrasDiagnostic.arm(100L)
        AlfaExtrasDiagnostic.capture("ru.alfabank.mobile.android", "private-key-A", extras, 101L)
        AlfaExtrasDiagnostic.capture("ru.alfabank.mobile.android", "private-key-A", extras, 102L)
        AlfaExtrasDiagnostic.capture("ru.alfabank.mobile.android", "private-key-B", extras, 103L)
        val report = AlfaExtrasDiagnostic.display(104L)
        assertTrue(report.contains("Notification 1: key=new"))
        assertTrue(report.contains("Notification 2: key=same"))
        assertTrue(report.contains("Notification 3: key=new"))
        assertTrue(report.contains("POSSIBLE_OPERATION_ID"))
        assertTrue(report.contains("POSSIBLE_AMOUNT"))
        for (secret in listOf("Пятёрочка", "26,00", "5580", "123456789", "secret-123", "private-bank-operation", "private-key", "com.alfa")) {
            assertFalse(report.contains(secret))
        }
    }

    @Test fun expiresAndErasesReport() {
        AlfaExtrasDiagnostic.arm(100L)
        AlfaExtrasDiagnostic.capture("ru.alfabank.mobile.android", "key", Bundle(), 101L)
        assertTrue(AlfaExtrasDiagnostic.display(300_101L).contains("Alfa diagnostic finished"))
        assertFalse(AlfaExtrasDiagnostic.display(420_102L).contains("Notification 1"))
    }

    @Test fun explicitCloseErasesReport() {
        AlfaExtrasDiagnostic.arm(100L)
        repeat(3) { AlfaExtrasDiagnostic.capture("ru.alfabank.mobile.android", "key-$it", Bundle(), 101L + it) }
        AlfaExtrasDiagnostic.clearFinishedReport()
        assertFalse(AlfaExtrasDiagnostic.display(105L).contains("Notification 1"))
    }
}
