package com.adamaste.buhguy.bankcollector.notification

import android.app.Notification
import android.os.Bundle
import android.os.SystemClock
import java.security.MessageDigest
import java.security.SecureRandom

/** One-shot, process-local diagnostic. No notification values or keys are persisted or logged. */
object AlfaExtrasDiagnostic {
    private const val PACKAGE = "ru.alfabank.mobile.android"
    private const val WINDOW_MS = 5 * 60_000L
    private const val REPORT_MS = 2 * 60_000L
    private const val MAX_EVENTS = 3
    private val standard = mapOf(
        Notification.EXTRA_TITLE to "TITLE",
        Notification.EXTRA_TITLE_BIG to "TITLE_BIG",
        Notification.EXTRA_TEXT to "TEXT",
        Notification.EXTRA_BIG_TEXT to "BIG_TEXT",
        Notification.EXTRA_SUB_TEXT to "SUB_TEXT",
        Notification.EXTRA_INFO_TEXT to "INFO_TEXT",
        Notification.EXTRA_SUMMARY_TEXT to "SUMMARY_TEXT",
        Notification.EXTRA_TEXT_LINES to "TEXT_LINES",
        Notification.EXTRA_MESSAGES to "MESSAGES",
        Notification.EXTRA_HISTORIC_MESSAGES to "HISTORIC_MESSAGES",
        Notification.EXTRA_TEMPLATE to "TEMPLATE",
    )
    private var armedUntil = 0L
    private var reportUntil = 0L
    private var salt = ByteArray(0)
    private val seenKeys = mutableSetOf<String>()
    private val reports = mutableListOf<String>()

    @Synchronized fun arm(now: Long = SystemClock.elapsedRealtime()) {
        clear()
        salt = ByteArray(32).also(SecureRandom()::nextBytes)
        armedUntil = now + WINDOW_MS
    }

    @Synchronized fun clear() {
        salt.fill(0)
        salt = ByteArray(0)
        armedUntil = 0L
        reportUntil = 0L
        seenKeys.clear()
        reports.clear()
    }

    @Synchronized fun clearFinishedReport() {
        if (reportUntil > 0L) clear()
    }

    @Synchronized fun capture(packageName: String, notificationKey: String?, extras: Bundle, now: Long = SystemClock.elapsedRealtime()) {
        if (packageName != PACKAGE || armedUntil == 0L) return
        expire(now)
        if (armedUntil == 0L) return
        val keyRelation = if (notificationKey.isNullOrBlank()) "unavailable" else {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(salt + notificationKey.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            if (seenKeys.add(digest)) "new" else "same"
        }
        val fields = try {
            extras.keySet().take(64).mapIndexed { index, key ->
                val value = extras.get(key)
                val label = standard[key] ?: "CUSTOM_${index + 1}"
                val role = if (key in standard) "" else candidateRole(key)
                "$label:${typeOf(value)}$role${markers(value)}"
            }
        } catch (_: Exception) { listOf("EXTRAS_READ_ERROR") }
        reports += "Notification ${reports.size + 1}: key=$keyRelation; fields=${fields.joinToString(", ")}".take(3000)
        if (reports.size >= MAX_EVENTS) {
            armedUntil = 0L
            reportUntil = now + REPORT_MS
            salt.fill(0)
            salt = ByteArray(0)
            seenKeys.clear()
        }
    }

    @Synchronized fun display(now: Long = SystemClock.elapsedRealtime()): String {
        expire(now)
        return when {
            armedUntil > 0L -> "Alfa diagnostic active. ${reports.size}/$MAX_EVENTS callbacks.\n${reports.joinToString("\n")}"
            reportUntil > 0L -> "Alfa diagnostic finished. Report clears in two minutes or when this screen closes.\n${reports.joinToString("\n")}"
            else -> "Alfa diagnostic off. No report stored."
        }
    }

    private fun expire(now: Long) {
        if (armedUntil > 0L && now >= armedUntil) {
            armedUntil = 0L
            reportUntil = if (reports.isEmpty()) 0L else now + REPORT_MS
            salt.fill(0)
            salt = ByteArray(0)
            seenKeys.clear()
        }
        if (reportUntil > 0L && now >= reportUntil) clear()
    }

    private fun candidateRole(key: String): String {
        val name = key.lowercase()
        return when {
            name.contains("transaction") || name.contains("operation") || name.endsWith("id") -> ":POSSIBLE_OPERATION_ID"
            name.contains("amount") || name.contains("sum") -> ":POSSIBLE_AMOUNT"
            name.contains("merchant") || name.contains("shop") -> ":POSSIBLE_MERCHANT"
            name.contains("type") || name.contains("status") -> ":POSSIBLE_OPERATION_TYPE"
            else -> ""
        }
    }

    private fun typeOf(value: Any?): String = when (value) {
        null -> "NULL"
        is CharSequence -> "TEXT"
        is Number -> "NUMBER"
        is Boolean -> "BOOLEAN"
        is Bundle -> "BUNDLE"
        is Array<*> -> "ARRAY"
        else -> "OTHER"
    }

    private fun markers(value: Any?): String {
        val text = value as? CharSequence ?: return ""
        val sample = text.take(4096).toString()
        val labels = buildList {
            if (Regex("(?iu)покуп|оплат|purchase|payment").containsMatchIn(sample)) add("PURCHASE_WORD")
            if (Regex("(?iu)перевод|transfer").containsMatchIn(sample)) add("TRANSFER_WORD")
            if (Regex("(?iu)возврат|refund").containsMatchIn(sample)) add("REFUND_WORD")
            if (Regex("(?iu)баланс|остаток").containsMatchIn(sample)) add("BALANCE_WORD")
            if (Regex("(?u)\\d+[,.]\\d{2}\\s*(?:₽|RUB)").containsMatchIn(sample)) add("MONEY_SHAPE")
            if (Regex("(?u)[•*]{2,}\\s*\\d{4}").containsMatchIn(sample)) add("CARD_MASK_SHAPE")
        }
        return if (labels.isEmpty()) "" else ":${labels.joinToString("+")}"
    }
}
