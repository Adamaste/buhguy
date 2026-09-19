package com.adamaste.buhguy.bankcollector.model

import kotlinx.serialization.Serializable

@Serializable
data class BankNotificationEvent(
    val sourceKey: String,
    val sourceEventId: String,
    val observedAt: String,
    val eventTime: String?,
    val payload: Map<String, String?>,
    val ingestionMetadata: Map<String, String?>,
)

enum class OutboxStatus { PENDING, SENT, PERMANENTLY_REJECTED }

data class OutboxEvent(
    val id: Long,
    val sourceEventId: String,
    val packageName: String,
    val eventJson: String,
    val status: OutboxStatus = OutboxStatus.PENDING,
    val retryCount: Int = 0,
)
