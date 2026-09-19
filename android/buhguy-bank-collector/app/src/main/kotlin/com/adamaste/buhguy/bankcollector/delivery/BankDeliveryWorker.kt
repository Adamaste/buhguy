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
import java.util.concurrent.TimeUnit
import java.time.Instant

interface BankTransport {
    suspend fun send(eventJson: String): TransportResult
}

data class TransportResult(val httpStatus: Int?, val serverStatus: String? = null, val networkFailure: Boolean = false)

class BankDeliveryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val database = AppRuntime.database(applicationContext)
        val transport = AppRuntime.transport(applicationContext)
        for (entity in database.outbox().pending(50)) {
            val result = runCatching { transport.send(entity.eventJson) }
                .getOrElse { TransportResult(null, networkFailure = true) }
            when (val decision = deliveryDecision(result.httpStatus, result.networkFailure, result.serverStatus)) {
                DeliveryDecision.Sent -> {
                    database.outbox().setStatus(entity.id, "SENT")
                    com.adamaste.buhguy.bankcollector.AppPreferences(applicationContext).markSuccessfulDelivery(Instant.now().toString())
                    Log.i("BankDelivery", "event=${entity.sourceEventId.take(12)} package=${entity.packageName} status=SENT retry=${entity.retryCount}")
                }
                is DeliveryDecision.PermanentlyRejected -> {
                    database.outbox().setStatus(entity.id, "PERMANENTLY_REJECTED", decision.reason)
                    Log.w("BankDelivery", "event=${entity.sourceEventId.take(12)} package=${entity.packageName} status=REJECTED http=${result.httpStatus}")
                }
                DeliveryDecision.Retry -> {
                    database.outbox().markRetry(entity.id, "transient delivery failure")
                    Log.w("BankDelivery", "event=${entity.sourceEventId.take(12)} package=${entity.packageName} status=RETRY http=${result.httpStatus} retry=${entity.retryCount + 1}")
                    return Result.retry()
                }
            }
        }
        return Result.success()
    }
}

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
