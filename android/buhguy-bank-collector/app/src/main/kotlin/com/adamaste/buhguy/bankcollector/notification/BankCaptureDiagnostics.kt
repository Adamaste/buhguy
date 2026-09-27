package com.adamaste.buhguy.bankcollector.notification

import android.util.Log

const val BANK_CAPTURE_LOG_TAG = "BankCapture"
const val BANK_CAPTURE_ROOM_INSERT_STAGE = "room_insert"
const val BANK_CAPTURE_ENQUEUE_STAGE = "enqueue"

enum class BankCaptureOutcome {
    CAPTURED,
    INSERTED,
    DUPLICATE,
    ERROR,
}

data class BankCaptureLogEvent(
    val packageName: String? = null,
    val outcome: BankCaptureOutcome? = null,
    val eventPrefix: String? = null,
    val postTime: Long? = null,
    val notificationId: Int? = null,
    val hasTag: Boolean? = null,
    val rowId: Long? = null,
    val stage: String? = null,
    val reason: String? = null,
    val listenerState: String? = null,
    val errorType: String? = null,
)

object BankCaptureDiagnostics {
    fun eventPrefix(sourceEventId: String): String = sourceEventId.take(12)

    fun insertOutcome(rowId: Long): BankCaptureOutcome =
        if (rowId == -1L) BankCaptureOutcome.DUPLICATE else BankCaptureOutcome.INSERTED

    fun message(event: BankCaptureLogEvent): String = buildString {
        event.stage?.let { append("stage=").append(it).append(' ') }
        event.packageName?.let { append("package=").append(it).append(' ') }
        event.outcome?.let { append("outcome=").append(it.name).append(' ') }
        event.reason?.let { append("reason=").append(it).append(' ') }
        event.listenerState?.let { append("state=").append(it).append(' ') }
        event.eventPrefix?.let { append("event=").append(it).append(' ') }
        event.postTime?.let { append("postTime=").append(it).append(' ') }
        event.notificationId?.let { append("notificationId=").append(it).append(' ') }
        event.hasTag?.let { append("hasTag=").append(it).append(' ') }
        event.rowId?.let { append("row=").append(it).append(' ') }
        event.errorType?.let { append("error=").append(it) }
    }.trim()

    fun log(event: BankCaptureLogEvent) {
        val message = message(event)
        if (event.outcome == BankCaptureOutcome.ERROR) Log.e(BANK_CAPTURE_LOG_TAG, message)
        else Log.i(BANK_CAPTURE_LOG_TAG, message)
    }
}
