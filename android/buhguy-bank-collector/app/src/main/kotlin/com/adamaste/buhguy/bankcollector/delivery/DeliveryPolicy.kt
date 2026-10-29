package com.adamaste.buhguy.bankcollector.delivery

sealed interface DeliveryDecision {
    data object Sent : DeliveryDecision
    data object Retry : DeliveryDecision
    data class PreservePending(val reason: String) : DeliveryDecision
    data class PermanentlyRejected(val reason: String) : DeliveryDecision
}

fun deliveryDecision(httpStatus: Int?, networkFailure: Boolean, serverStatus: String? = null, serverCode: String? = null): DeliveryDecision = when {
    networkFailure -> DeliveryDecision.Retry
    httpStatus == null -> DeliveryDecision.Retry
    httpStatus == 401 -> DeliveryDecision.PreservePending("AUTH_REQUIRED")
    httpStatus == 403 && serverCode == "SOURCE_MISMATCH" -> DeliveryDecision.PreservePending("SOURCE_MISMATCH")
    httpStatus == 429 || httpStatus >= 500 -> DeliveryDecision.Retry
    httpStatus in 200..299 && (serverStatus == "created" || serverStatus == "duplicate") -> DeliveryDecision.Sent
    httpStatus in 400..499 || serverStatus == "rejected" -> DeliveryDecision.PermanentlyRejected(
        if (serverCode == "SENSITIVE_AUTH_NOTIFICATION") serverCode else serverStatus ?: "HTTP_$httpStatus",
    )
    else -> DeliveryDecision.Retry
}
