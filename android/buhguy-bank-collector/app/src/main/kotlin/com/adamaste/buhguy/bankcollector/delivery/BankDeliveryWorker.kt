package com.adamaste.buhguy.bankcollector.delivery

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.adamaste.buhguy.bankcollector.BankCollectorApplication
import com.adamaste.buhguy.bankcollector.notification.SensitiveBankNotificationFilter
import com.adamaste.buhguy.bankcollector.notification.StoredEventScreening
import com.adamaste.buhguy.bankcollector.AppPreferences
import com.adamaste.buhguy.bankcollector.notification.BankCaptureDiagnostics
import java.util.concurrent.TimeUnit
import java.time.Instant

interface BankTransport {
    suspend fun send(eventJson: String): TransportResult
}

data class TransportResult(val httpStatus: Int?, val serverStatus: String? = null, val networkFailure: Boolean = false, val serverCode: String? = null)

class BankDeliveryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val database = AppRuntime.database(applicationContext)
        val transport = AppRuntime.transport(applicationContext)
        for (entity in database.outbox().pending(50)) {
            when (SensitiveBankNotificationFilter.screenStoredEvent(entity.eventJson)) {
                StoredEventScreening.SAFE -> Unit
                StoredEventScreening.SENSITIVE_AUTH -> {
                    database.outbox().setStatus(entity.id, "PERMANENTLY_REJECTED", "SENSITIVE_AUTH_NOTIFICATION")
                    Log.w("BankDelivery", "package=${entity.packageName} status=REJECTED reason=SENSITIVE_AUTH_NOTIFICATION")
                    continue
                }
                StoredEventScreening.UNREADABLE -> {
                    database.outbox().setStatus(entity.id, "HELD_FOR_REVIEW", "OUTBOX_CONTENT_UNREADABLE")
                    Log.w("BankDelivery", "package=${entity.packageName} status=HELD_FOR_REVIEW reason=OUTBOX_CONTENT_UNREADABLE")
                    continue
                }
            }
            val result = runCatching { transport.send(entity.eventJson) }
                .getOrElse { error -> transportFailureResult(error) }
            when (val decision = deliveryDecision(result.httpStatus, result.networkFailure, result.serverStatus, result.serverCode)) {
                DeliveryDecision.Sent -> {
                    database.outbox().setStatus(entity.id, "SENT")
                    val eventPrefix = BankCaptureDiagnostics.eventPrefix(entity.sourceEventId)
                    val serverStatus = result.serverStatus?.takeIf { it == "created" || it == "duplicate" } ?: "unknown"
                    AppPreferences(applicationContext).markSuccessfulDelivery(
                        timestamp = Instant.now().toString(),
                        packageName = entity.packageName,
                        eventPrefix = eventPrefix,
                        serverStatus = serverStatus,
                    )
                    Log.i("BankDelivery", "event=$eventPrefix package=${entity.packageName} status=SENT retry=${entity.retryCount}")
                }
                is DeliveryDecision.PermanentlyRejected -> {
                    database.outbox().setStatus(entity.id, "PERMANENTLY_REJECTED", decision.reason)
                    Log.w("BankDelivery", "event=${BankCaptureDiagnostics.eventPrefix(entity.sourceEventId)} package=${entity.packageName} status=REJECTED http=${result.httpStatus}")
                }
                is DeliveryDecision.PreservePending -> {
                    database.outbox().markPendingIssue(entity.id, decision.reason)
                    Log.w("BankDelivery", "event=${BankCaptureDiagnostics.eventPrefix(entity.sourceEventId)} package=${entity.packageName} status=PENDING reason=${decision.reason}")
                    return Result.success()
                }
                DeliveryDecision.Retry -> {
                    database.outbox().markRetry(entity.id, "transient delivery failure")
                    Log.w("BankDelivery", "event=${BankCaptureDiagnostics.eventPrefix(entity.sourceEventId)} package=${entity.packageName} status=RETRY http=${result.httpStatus} retry=${entity.retryCount + 1}")
                    return Result.retry()
                }
            }
        }
        return Result.success()
    }
}

fun transportFailureResult(_error: Throwable): TransportResult = TransportResult(null, networkFailure = true)

object AppRuntime {
    fun database(context: Context): com.adamaste.buhguy.bankcollector.outbox.CollectorDatabase = (context.applicationContext as BankCollectorApplication).database
    fun transport(context: Context): BankTransport = (context.applicationContext as BankCollectorApplication).transport

    fun enqueue(context: Context) {
        val request = OneTimeWorkRequestBuilder<BankDeliveryWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueue(request)
    }
}
