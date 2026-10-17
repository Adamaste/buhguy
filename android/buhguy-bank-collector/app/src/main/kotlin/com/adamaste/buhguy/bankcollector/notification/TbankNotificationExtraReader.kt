package com.adamaste.buhguy.bankcollector.notification

import android.app.Notification
import android.os.Bundle

data class NotificationExtraSnapshot(
    val presentFields: Set<String>,
    val values: Map<String, List<String>>,
)

object TbankNotificationExtraReader {
    private val keys = listOf(
        "EXTRA_TITLE" to Notification.EXTRA_TITLE,
        "EXTRA_TITLE_BIG" to Notification.EXTRA_TITLE_BIG,
        "EXTRA_TEXT" to Notification.EXTRA_TEXT,
        "EXTRA_BIG_TEXT" to Notification.EXTRA_BIG_TEXT,
        "EXTRA_SUB_TEXT" to Notification.EXTRA_SUB_TEXT,
        "EXTRA_INFO_TEXT" to Notification.EXTRA_INFO_TEXT,
        "EXTRA_SUMMARY_TEXT" to Notification.EXTRA_SUMMARY_TEXT,
        "EXTRA_CONVERSATION_TITLE" to Notification.EXTRA_CONVERSATION_TITLE,
        "EXTRA_TEXT_LINES" to Notification.EXTRA_TEXT_LINES,
        "EXTRA_MESSAGES" to Notification.EXTRA_MESSAGES,
        "EXTRA_HISTORIC_MESSAGES" to Notification.EXTRA_HISTORIC_MESSAGES,
        "EXTRA_REMOTE_INPUT_HISTORY" to Notification.EXTRA_REMOTE_INPUT_HISTORY,
    )

    fun read(extras: Bundle): NotificationExtraSnapshot {
        val present = keys.filter { (_, key) -> extras.containsKey(key) }.map { it.first }.toSet()
        val values = keys.associate { (name, key) ->
            name to when (name) {
                "EXTRA_TEXT_LINES", "EXTRA_REMOTE_INPUT_HISTORY" -> textLines(extras, key)
                "EXTRA_MESSAGES", "EXTRA_HISTORIC_MESSAGES" -> messageTexts(extras, key)
                else -> scalar(extras, key)
            }
        }
        return NotificationExtraSnapshot(present, values)
    }

    private fun scalar(extras: Bundle, key: String): List<String> =
        extras.getCharSequence(key)?.toString()?.let(::listOf).orEmpty()

    private fun textLines(extras: Bundle, key: String): List<String> =
        extras.getCharSequenceArray(key)?.mapNotNull { it?.toString() }.orEmpty()

    private fun messageTexts(extras: Bundle, key: String): List<String> =
        extras.getParcelableArray(key).orEmpty().mapNotNull { (it as? Bundle)?.getCharSequence("text")?.toString() }
}
