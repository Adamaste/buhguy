package com.adamaste.buhguy.bankcollector

data class DiagnosticsSnapshot(
    val pendingCount: Int,
    val lastSuccessfulDeliveryAt: String,
    val lastSuccessfulDeliveryPackage: String,
    val lastSuccessfulDeliveryEventPrefix: String,
    val lastSuccessfulDeliveryServerStatus: String,
    val lastCaptureOutcome: String,
    val lastCapturePackage: String,
    val lastCaptureEventPrefix: String,
    val lastCaptureAt: String,
    val lastCallbackStage: String,
    val lastCallbackPackage: String,
    val lastCallbackAt: String,
    val listenerState: String,
    val listenerStateAt: String,
) {
    fun render(): String = listOf(
        "Pending events: $pendingCount",
        "Last successful delivery: $lastSuccessfulDeliveryServerStatus $lastSuccessfulDeliveryPackage $lastSuccessfulDeliveryEventPrefix at $lastSuccessfulDeliveryAt",
        "Last capture: $lastCaptureOutcome $lastCapturePackage $lastCaptureEventPrefix at $lastCaptureAt",
        "Last callback: $lastCallbackStage $lastCallbackPackage at $lastCallbackAt",
        "Listener lifecycle: $listenerState at $listenerStateAt",
        "Auth provisioning is separate.",
    ).joinToString("\n")
}

fun AppPreferences.diagnosticsSnapshot(pendingCount: Int): DiagnosticsSnapshot = DiagnosticsSnapshot(
    pendingCount = pendingCount,
    lastSuccessfulDeliveryAt = lastSuccessfulDelivery(),
    lastSuccessfulDeliveryPackage = lastSuccessfulDeliveryPackage(),
    lastSuccessfulDeliveryEventPrefix = lastSuccessfulDeliveryEventPrefix(),
    lastSuccessfulDeliveryServerStatus = lastSuccessfulDeliveryServerStatus(),
    lastCaptureOutcome = lastCaptureOutcome(),
    lastCapturePackage = lastCapturePackage(),
    lastCaptureEventPrefix = lastCaptureEventPrefix(),
    lastCaptureAt = lastCaptureAt(),
    lastCallbackStage = lastCallbackStage(),
    lastCallbackPackage = lastCallbackPackage(),
    lastCallbackAt = lastCallbackAt(),
    listenerState = lastListenerState(),
    listenerStateAt = lastListenerStateAt(),
)
