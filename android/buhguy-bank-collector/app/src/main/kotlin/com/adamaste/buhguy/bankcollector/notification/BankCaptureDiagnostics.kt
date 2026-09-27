package com.adamaste.buhguy.bankcollector.notification

import android.util.Log

const val BANK_CAPTURE_LOG_TAG = "BankCapture"

enum class BankCaptureOutcome {
    CAPTURED,
    INSERTED,
    DUPLICATE,
    ERROR,
}

data class BankCaptureLogEvent(
    val packageName: String,
    val outcome: BankCaptureOutcome,
    val eventPrefix: String,
    val postTime: Long? = null,
    val notificationId: Int? = null,
    val hasTag: Boolean? = null,
    val rowId: Long? = null,
    val stage: String? = null,
    val errorType: String? = null,
)

object BankCaptureDiagnostics {
    fun eventPrefix(sourceEventId: String): String = sourceEventId.take(12)

    fun insertOutcome(rowId: Long): BankCaptureOutcome =
        if (rowId == -1L) BankCaptureOutcome.DUPLICATE else BankCaptureOutcome.INSERTED

    fun message(event: BankCaptureLogEvent): String = buildString {
        append("package=").append(event.packageName)
        append(" outcome=").append(event.outcome.name)
        append(" event=").append(event.eventPrefix)
        event.postTime?.let { append(" postTime=").append(it) }
        event.notificationId?.let { append(" notificationId=").append(it) }
        event.hasTag?.let { append(" hasTag=").append(it) }
        event.rowId?.let { append(" row=").append(it) }
        event.stage?.let { append(" stage=").append(it) }
        event.errorType?.let { append(" error=").append(it) }
    }

    fun log(event: BankCaptureLogEvent) {
        val message = message(event)
        when (event.outcome) {
            BankCaptureOutcome.ERROR -> Log.e(BANK_CAPTURE_LOG_TAG, message)
            else -> Log.i(BANK_CAPTURE_LOG_TAG, message)
        }
    }
}
