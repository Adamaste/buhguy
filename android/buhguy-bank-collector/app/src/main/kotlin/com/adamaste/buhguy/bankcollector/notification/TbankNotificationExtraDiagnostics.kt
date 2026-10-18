package com.adamaste.buhguy.bankcollector.notification

const val TBANK_PROVIDER_PACKAGE = "com.idamob.tinkoff.android"

object TbankNotificationExtraDiagnostics {
    private val fieldNames = listOf(
        "EXTRA_TITLE",
        "EXTRA_TITLE_BIG",
        "EXTRA_TEXT",
        "EXTRA_BIG_TEXT",
        "EXTRA_SUB_TEXT",
        "EXTRA_INFO_TEXT",
        "EXTRA_SUMMARY_TEXT",
        "EXTRA_CONVERSATION_TITLE",
        "EXTRA_TEXT_LINES",
        "EXTRA_MESSAGES",
        "EXTRA_HISTORIC_MESSAGES",
        "EXTRA_REMOTE_INPUT_HISTORY",
    )

    private val purchasePattern = Regex("(?iu)покуп\\p{L}*|оплат\\p{L}*|списан\\p{L}*|purchase|payment")
    private val confirmedCardMask = Regex("(?iu)[*•xх]{1,6}\\s*7268\\b")
    private val anyCardMask = Regex("(?iu)[*•xх]{1,6}\\s*\\d{4}\\b")
    private val balanceWithValue = Regex(
        "(?iu)(?:баланс|остаток|доступно|свободно)\\b[^\\d]{0,24}\\d[\\d \\u00a0.,]*(?:\\s*(?:₽|руб(?:\\.|лей|ля)?|RUB|р\\.))?",
    )
    private val valueWithBalance = Regex(
        "(?iu)\\d[\\d \\u00a0.,]*(?:\\s*(?:₽|руб(?:\\.|лей|ля)?|RUB|р\\.))?[^\\d]{0,24}(?:баланс|остаток|доступно|свободно)\\b",
    )
    private val currencyAmount = Regex(
        "(?iu)(?<![\\p{L}\\d])\\d{1,3}(?:[ \\u00a0]\\d{3})*(?:[.,]\\d{1,2})?(?=\\s*(?:₽|руб(?:\\.|лей|ля)?|RUB|р\\.))",
    )
    private val decimalAmount = Regex("(?<![\\p{L}\\d])\\d+(?:[.,]\\d{2})(?!\\d)")
    private val safeWord = Regex(
        "(?iu)покуп\\p{L}*|оплат\\p{L}*|списан\\p{L}*|перевод\\p{L}*|пополн\\p{L}*|баланс|остаток|доступно|свободно|purchase|payment|debit|transfer|top.?up|RUB|USD|EUR|руб(?:\\.|лей|ля)?|р\\.|₽",
    )
    private val anyNumber = Regex("\\d+")

    fun shouldCapture(packageName: String, visibleText: List<String?>): Boolean =
        packageName == TBANK_PROVIDER_PACKAGE &&
            visibleText.filterNotNull().any { purchasePattern.containsMatchIn(it) } &&
            visibleText.filterNotNull().any { confirmedCardMask.containsMatchIn(it) }

    fun render(packageName: String, extras: NotificationExtraSnapshot): String? {
        if (packageName != TBANK_PROVIDER_PACKAGE) return null
        return buildList {
            add("provider=$TBANK_PROVIDER_PACKAGE")
            fieldNames.forEach { name ->
                val values = extras.values[name].orEmpty()
                if (name !in extras.presentFields) {
                    add("$name=ABSENT")
                } else {
                    val shapes = values.take(MAX_ITEMS).map(::shape)
                    add("$name=PRESENT(items=${values.size},shape=${shapes.joinToString(" || ")})")
                }
            }
        }.joinToString("\n")
    }

    fun readFailureReport(packageName: String): String? =
        if (packageName == TBANK_PROVIDER_PACKAGE) "$TBANK_PROVIDER_PACKAGE\nEXTRA_READ_STATUS=FAILED" else null

    private data class Span(val start: Int, val end: Int, val token: String, val priority: Int)

    private fun shape(value: String): String {
        val text = value.take(MAX_TEXT_LENGTH)
        val spans = mutableListOf<Span>()
        fun collect(regex: Regex, priority: Int, token: (MatchResult) -> String) {
            regex.findAll(text).forEach { match -> spans += Span(match.range.first, match.range.last + 1, token(match), priority) }
        }

        collect(balanceWithValue, 100) { "<BALANCE>" }
        collect(valueWithBalance, 100) { "<BALANCE>" }
        collect(confirmedCardMask, 95) { "CARD_MASK(*7268)" }
        collect(anyCardMask, 90) { "CARD_MASK" }
        collect(currencyAmount, 80) { "<AMOUNT>" }
        collect(decimalAmount, 75) { "<AMOUNT>" }
        collect(safeWord, 60) { match -> safeToken(match.value) }
        collect(anyNumber, 40) { "<NUMBER>" }

        val result = mutableListOf<String>()
        var cursor = 0
        spans.sortedWith(compareBy<Span> { it.start }.thenByDescending { it.priority }.thenByDescending { it.end })
            .forEach { span ->
                if (span.start < cursor) return@forEach
                if (text.substring(cursor, span.start).any(Char::isLetterOrDigit)) result += "TEXT"
                result += span.token
                cursor = span.end
            }
        if (text.substring(cursor).any(Char::isLetterOrDigit)) result += "TEXT"
        if (result.isEmpty()) result += "<EMPTY>"
        val bounded = result.take(MAX_SHAPE_MARKERS).toMutableList()
        if (result.size > MAX_SHAPE_MARKERS) bounded += "TRUNCATED"
        return bounded.joinToString(" ")
    }

    private fun safeToken(value: String): String {
        val normalized = value.lowercase()
        return when {
            normalized.startsWith("покуп") || normalized == "purchase" -> "PURCHASE"
            normalized.startsWith("оплат") || normalized == "payment" -> "PAYMENT"
            normalized.startsWith("списан") || normalized == "debit" -> "DEBIT"
            normalized.startsWith("перевод") || normalized == "transfer" -> "TRANSFER"
            normalized.startsWith("пополн") || normalized.startsWith("top") -> "TOP_UP"
            normalized in setOf("баланс", "остаток", "доступно", "свободно") -> "BALANCE_LABEL"
            normalized == "₽" || normalized.startsWith("руб") || normalized.startsWith("р.") -> "RUB"
            else -> "${value.uppercase().takeWhile(Char::isLetter).ifBlank { "CURRENCY" }}"
        }
    }

    private const val MAX_ITEMS = 20
    private const val MAX_TEXT_LENGTH = 4_096
    private const val MAX_SHAPE_MARKERS = 60
}
