package com.adamaste.buhguy.bankcollector.notification

import java.text.Normalizer
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

enum class StoredEventScreening { SAFE, SENSITIVE_AUTH, UNREADABLE }

/** Screens only text fields that NotificationEventMapper can persist. */
object SensitiveBankNotificationFilter {
    private val zeroWidth = Regex("[\\u200B-\\u200D\\u2060\\uFEFF]")
    private val otpLanguage = listOf(
        Regex("одноразов\\p{L}*\\s+(?:код|парол)\\p{L}*", RegexOption.IGNORE_CASE),
        Regex("(?:код|парол)\\p{L}*\\s+(?:для\\s+)?(?:подтвержден|авторизац|верификац|безопасност)\\p{L}*", RegexOption.IGNORE_CASE),
        Regex("(?:код|парол)\\p{L}*\\s+(?:из\\s+)?(?:смс|sms)\\b", RegexOption.IGNORE_CASE),
        Regex("(?:сообщени[ея]|message)\\s+(?:об?\\s*)?(?:авторизац|подтвержден|authorization|verification)\\p{L}*", RegexOption.IGNORE_CASE),
        Regex("\\b(?:otp|sms\\s+(?:verification\\s+)?code|confirmation\\s+code|verification\\s+code|authentication\\s+code|authorization\\s+code|security\\s+code|one[-\\s]?time\\s+(?:code|password|passcode))\\b", RegexOption.IGNORE_CASE),
        Regex("(?:никому\\s+не\\s+(?:сообщайте|передавайте|называйте)|не\\s+(?:сообщайте|передавайте|называйте)\\s+(?:этот\\s+)?(?:код|парол)\\w*)", RegexOption.IGNORE_CASE),
        Regex("\\b(?:do\\s+not|never)\\s+(?:share|tell|disclose)\\s+(?:this\\s+)?(?:code|password)\\b", RegexOption.IGNORE_CASE),
    )
    private val codeWithShortNumber = Regex("(?:^|[^\\p{L}\\p{N}])(?:(?:код|парол)\\p{L}*|code|password)\\s*(?::|№|#|-)?\\s*(?:\\s+)?\\d{4,8}(?=$|[^\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
    private val nonAuthReferencePrefix = Regex("(?:operation|transaction|reference|mcc|merchant|shop|store|order|purchase|операц\\p{L}*|транзакц\\p{L}*|ссылк\\p{L}*|магазин\\p{L}*|заказ\\p{L}*)\\s*$", RegexOption.IGNORE_CASE)
    private val bareShortCode = Regex("^\\s*\\d{4,8}\\s*$")

    /** Returns only a boolean. Source text is never returned, persisted, or logged. */
    fun shouldReject(fields: Iterable<CharSequence?>, rejectBareShortCode: Boolean = true): Boolean = try {
        inspect(fields, rejectBareShortCode)
    } catch (_: Exception) {
        // Fail closed if a platform-provided text value cannot be safely inspected.
        true
    }

    private fun inspect(fields: Iterable<CharSequence?>, rejectBareShortCode: Boolean): Boolean {
        val texts = fields.filterNotNull().map(::normalizeText)
        for (text in texts) {
            if (otpLanguage.any { it.containsMatchIn(text) }) return true
            if (rejectBareShortCode && bareShortCode.matches(text)) return true
            val match = codeWithShortNumber.find(text) ?: continue
            if (!nonAuthReferencePrefix.containsMatchIn(text.substring(0, match.range.first))) return true
        }
        return false
    }

    fun shouldReject(snapshot: NotificationSnapshot): Boolean = shouldReject(
        listOf(snapshot.title, snapshot.text, snapshot.bigText, snapshot.subText),
    )

    fun screenStoredEvent(eventJson: String): StoredEventScreening = try {
        val root = Json.parseToJsonElement(eventJson).jsonObject
        val payload = root["payload"] as? JsonObject ?: return StoredEventScreening.UNREADABLE
        val payloadText = listOf("title", "text", "description", "reference")
            .map { key -> payload[key].asTextOrNull() }
        val allStrings = buildList {
            listOf("sourceKey", "sourceEventId", "observedAt", "eventTime").forEach { add(root[it].asTextOrNull()) }
            payload.values.forEach { add(it.asTextOrNull()) }
            (root["ingestionMetadata"] as? JsonObject)?.values?.forEach { add(it.asTextOrNull()) }
        }
        if (shouldReject(allStrings, rejectBareShortCode = false)
            || shouldReject(payloadText, rejectBareShortCode = true)
        ) StoredEventScreening.SENSITIVE_AUTH else StoredEventScreening.SAFE
    } catch (_: Exception) {
        StoredEventScreening.UNREADABLE
    }

    private fun JsonElement?.asTextOrNull(): String? = (this as? JsonPrimitive)
        ?.takeIf { it.isString }
        ?.contentOrNull

    private fun normalizeText(value: CharSequence): String = Normalizer
        .normalize(value.toString().take(4096), Normalizer.Form.NFKC)
        .replace(zeroWidth, "")
        .replace(Regex("\\s+"), " ")
        .lowercase(Locale.ROOT)
}
