package com.adamaste.buhguy.bankcollector.notification

import java.math.BigDecimal

enum class YandexFinancialType { PURCHASE, INCOMING_TRANSFER }

enum class YandexClassifierReason {
    SUPPORTED_PURCHASE,
    SUPPORTED_INCOMING_TRANSFER,
    NON_FINANCIAL_NO_FINANCIAL_MARKER,
    UNKNOWN_PARTIAL_FINANCIAL_PATTERN,
    UNKNOWN_AMOUNT_INVALID,
    UNKNOWN_CURRENCY,
    UNKNOWN_UNSUPPORTED_FINANCIAL_TYPE,
    UNKNOWN_MISSING_REQUIRED_FIELD,
    STRONG_UNKNOWN_PURCHASE_ANCHOR,
    STRONG_UNKNOWN_INCOMING_TITLE_ANCHOR,
    STRONG_UNKNOWN_INCOMING_BODY_ANCHOR,
}

sealed interface YandexProClassification {
    data class Financial(val type: YandexFinancialType) : YandexProClassification
    data class NonFinancial(val reason: YandexClassifierReason) : YandexProClassification
    data class Unknown(val reason: YandexClassifierReason) : YandexProClassification
    data class StrongUnknown(val reason: YandexClassifierReason) : YandexProClassification
}

enum class YandexCaptureDecision { CAPTURE, DROP }

fun yandexCaptureDecision(classification: YandexProClassification): YandexCaptureDecision = when (classification) {
    is YandexProClassification.Financial,
    is YandexProClassification.StrongUnknown,
    -> YandexCaptureDecision.CAPTURE
    is YandexProClassification.NonFinancial,
    is YandexProClassification.Unknown,
    -> YandexCaptureDecision.DROP
}

class YandexProFinancialClassifier {
    fun classify(snapshot: NotificationSnapshot): YandexProClassification {
        val title = normalize(snapshot.title)
        val body = normalize(snapshot.bigText?.takeIf { it.isNotBlank() } ?: snapshot.text)
        if (title == null && body == null) return YandexProClassification.Unknown(YandexClassifierReason.UNKNOWN_MISSING_REQUIRED_FIELD)

        val purchaseMarker = body?.startsWith("покупка на", ignoreCase = true) == true
        val incomingTitle = title?.equals("входящий перевод", ignoreCase = true) == true
        val incomingMarker = body?.startsWith("пополнение на", ignoreCase = true) == true
        val unsupportedMarker = listOf("перевод", "возврат", "комиссия", "снятие").any {
            title?.contains(it, ignoreCase = true) == true || body?.contains(it, ignoreCase = true) == true
        }
        val amountLike = body?.contains(Regex("\\d+[.,]\\d+")) == true

        if (!purchaseMarker && !(incomingTitle || incomingMarker) && !amountLike && !unsupportedMarker) {
            return YandexProClassification.NonFinancial(YandexClassifierReason.NON_FINANCIAL_NO_FINANCIAL_MARKER)
        }
        if (unsupportedMarker && !purchaseMarker && !incomingTitle && !incomingMarker) {
            return YandexProClassification.Unknown(YandexClassifierReason.UNKNOWN_UNSUPPORTED_FINANCIAL_TYPE)
        }
        if (purchaseMarker) {
            return classifyAmount(
                body,
                PURCHASE_AMOUNT,
                YandexFinancialType.PURCHASE,
                YandexClassifierReason.STRONG_UNKNOWN_PURCHASE_ANCHOR,
            )
        }
        if (incomingTitle || incomingMarker) {
            if (!incomingTitle) {
                return YandexProClassification.StrongUnknown(YandexClassifierReason.STRONG_UNKNOWN_INCOMING_BODY_ANCHOR)
            }
            if (!incomingMarker) {
                return YandexProClassification.StrongUnknown(YandexClassifierReason.STRONG_UNKNOWN_INCOMING_TITLE_ANCHOR)
            }
            return classifyAmount(
                body,
                INCOMING_AMOUNT,
                YandexFinancialType.INCOMING_TRANSFER,
                YandexClassifierReason.STRONG_UNKNOWN_INCOMING_TITLE_ANCHOR,
            )
        }
        return YandexProClassification.Unknown(YandexClassifierReason.UNKNOWN_PARTIAL_FINANCIAL_PATTERN)
    }

    private fun classifyAmount(
        body: String?,
        pattern: Regex,
        type: YandexFinancialType,
        strongUnknownReason: YandexClassifierReason,
    ): YandexProClassification {
        if (body == null) return YandexProClassification.StrongUnknown(strongUnknownReason)
        val match = pattern.find(body)
        if (match == null) {
            return YandexProClassification.StrongUnknown(strongUnknownReason)
        }
        return try {
            BigDecimal(match.groupValues[1])
            YandexProClassification.Financial(type)
        } catch (_: NumberFormatException) {
            YandexProClassification.StrongUnknown(strongUnknownReason)
        }
    }

    private fun normalize(value: String?): String? = value?.trim()?.replace(Regex("\\s+"), " ")?.takeIf { it.isNotEmpty() }

    private companion object {
        val PURCHASE_AMOUNT = Regex("([0-9]+\\.[0-9]{2})\\s+RUB", RegexOption.IGNORE_CASE)
        val INCOMING_AMOUNT = Regex("([0-9]+\\.[0-9]{2})\\s+RUB", RegexOption.IGNORE_CASE)
    }
}
