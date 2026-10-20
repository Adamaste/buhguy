package com.adamaste.buhguy.bankcollector.notification

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

const val ALFA_NOTIFICATION_PACKAGE = "ru.alfabank.mobile.android"
const val ALFA_DIAGNOSTIC_MAX_EVENTS = 6
const val ALFA_DIAGNOSTIC_TIMEOUT_MS = 5 * 60 * 1000L

internal data class AlfaNotificationDiagnosticInput(
    val packageName: String,
    val notificationId: Int,
    val postTime: Long,
    val channelId: String?,
    val extrasNames: Collection<String>,
    val notificationKey: String?,
    val tag: String?,
    val groupKey: String?,
)

internal data class AlfaNotificationDiagnosticRow(
    val sequence: Int,
    val notificationId: Int,
    val postTime: Long,
    val channelId: String?,
    val extrasNames: List<String>,
    val notificationKeyHash: String?,
    val tagHash: String?,
    val groupKeyHash: String?,
)

internal data class AlfaNotificationDiagnosticState(
    val active: Boolean = false,
    val rows: List<AlfaNotificationDiagnosticRow> = emptyList(),
)

internal class AlfaOneShotNotificationDiagnosticSession(
    private val newSalt: () -> ByteArray = {
        ByteArray(32).also { SecureRandom().nextBytes(it) }
    },
) {
    private val mutableState = MutableStateFlow(AlfaNotificationDiagnosticState())
    val state: StateFlow<AlfaNotificationDiagnosticState> = mutableState.asStateFlow()

    private var salt: ByteArray? = null
    private var sessionStartedAtMs = 0L
    private var sessionId = 0L

    @Synchronized
    fun start(nowElapsedMs: Long): Long {
        salt?.fill(0)
        salt = newSalt().copyOf()
        sessionStartedAtMs = nowElapsedMs
        sessionId += 1
        mutableState.value = AlfaNotificationDiagnosticState(active = true)
        return sessionId
    }

    @Synchronized
    fun stop() {
        stopKeepingRows()
    }

    @Synchronized
    fun clear() {
        stopKeepingRows()
        mutableState.value = AlfaNotificationDiagnosticState()
    }

    @Synchronized
    fun expire(expectedSessionId: Long, nowElapsedMs: Long) {
        if (expectedSessionId == sessionId && mutableState.value.active &&
            nowElapsedMs - sessionStartedAtMs >= ALFA_DIAGNOSTIC_TIMEOUT_MS
        ) {
            stopKeepingRows()
        }
    }

    @Synchronized
    fun capture(input: AlfaNotificationDiagnosticInput, nowElapsedMs: Long): Boolean {
        if (input.packageName != ALFA_NOTIFICATION_PACKAGE || !mutableState.value.active) return false
        if (nowElapsedMs - sessionStartedAtMs >= ALFA_DIAGNOSTIC_TIMEOUT_MS) {
            stopKeepingRows()
            return false
        }

        val sessionSalt = salt ?: return false
        val currentRows = mutableState.value.rows
        if (currentRows.size >= ALFA_DIAGNOSTIC_MAX_EVENTS) {
            stopKeepingRows()
            return false
        }

        val row = AlfaNotificationDiagnosticRow(
            sequence = currentRows.size + 1,
            notificationId = input.notificationId,
            postTime = input.postTime,
            channelId = input.channelId?.take(128),
            extrasNames = input.extrasNames.asSequence()
                .map { it.take(128) }
                .distinct()
                .sorted()
                .take(64)
                .toList(),
            notificationKeyHash = sessionHash(sessionSalt, input.notificationKey),
            tagHash = sessionHash(sessionSalt, input.tag),
            groupKeyHash = sessionHash(sessionSalt, input.groupKey),
        )
        val rows = currentRows + row
        if (rows.size == ALFA_DIAGNOSTIC_MAX_EVENTS) clearSalt()
        mutableState.value = AlfaNotificationDiagnosticState(
            active = rows.size < ALFA_DIAGNOSTIC_MAX_EVENTS,
            rows = rows,
        )
        return true
    }

    private fun stopKeepingRows() {
        clearSalt()
        mutableState.value = mutableState.value.copy(active = false)
    }

    private fun clearSalt() {
        salt?.fill(0)
        salt = null
    }

    private fun sessionHash(sessionSalt: ByteArray, value: String?): String? {
        if (value.isNullOrEmpty()) return null
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sessionSalt, "HmacSHA256"))
        return mac.doFinal(value.toByteArray(StandardCharsets.UTF_8))
            .take(16)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}

internal object AlfaOneShotNotificationDiagnostics {
    private val handler = Handler(Looper.getMainLooper())
    private val session = AlfaOneShotNotificationDiagnosticSession()
    private var timeoutTask: Runnable? = null

    val state: StateFlow<AlfaNotificationDiagnosticState> = session.state

    fun start(): Long {
        cancelTimeout()
        val id = session.start(SystemClock.elapsedRealtime())
        val task = Runnable {
            session.expire(id, SystemClock.elapsedRealtime())
            timeoutTask = null
        }
        timeoutTask = task
        if (!handler.postDelayed(task, ALFA_DIAGNOSTIC_TIMEOUT_MS)) {
            timeoutTask = null
            session.stop()
        }
        return id
    }

    fun stop() {
        cancelTimeout()
        session.stop()
    }

    fun clear() {
        cancelTimeout()
        session.clear()
    }

    fun captureIfActive(sbn: StatusBarNotification) {
        if (sbn.packageName != ALFA_NOTIFICATION_PACKAGE || !session.state.value.active) return

        try {
            val extrasNames = sbn.notification.extras.keySet()
            session.capture(
                AlfaNotificationDiagnosticInput(
                    packageName = sbn.packageName,
                    notificationId = sbn.id,
                    postTime = sbn.postTime,
                    channelId = sbn.notification.channelId,
                    extrasNames = extrasNames,
                    notificationKey = sbn.key,
                    tag = sbn.tag,
                    groupKey = sbn.groupKey,
                ),
                SystemClock.elapsedRealtime(),
            )
            if (!session.state.value.active) cancelTimeout()
        } catch (_: Exception) {
            stop()
        }
    }

    private fun cancelTimeout() {
        timeoutTask?.let(handler::removeCallbacks)
        timeoutTask = null
    }
}

internal fun renderAlfaDiagnosticState(state: AlfaNotificationDiagnosticState): String = buildString {
    appendLine(if (state.active) "Диагностика включена" else "Диагностика выключена")
    appendLine("Собрано событий: ${state.rows.size}/$ALFA_DIAGNOSTIC_MAX_EVENTS")
    if (state.rows.isEmpty()) {
        append("Ожидание уведомлений Альфа-Банка")
        return@buildString
    }

    state.rows.forEach { row ->
        appendLine()
        appendLine("Событие #${row.sequence}")
        appendLine("Notification id: ${row.notificationId}")
        appendLine("postTime: ${row.postTime}")
        appendLine("channel: ${row.channelId ?: "<нет>"}")
        appendLine("extras keys: ${row.extrasNames.joinToString(", ").ifBlank { "<нет>" }}")
        appendLine("key HMAC: ${row.notificationKeyHash ?: "<нет>"}")
        appendLine("tag HMAC: ${row.tagHash ?: "<нет>"}")
        append("groupKey HMAC: ${row.groupKeyHash ?: "<нет>"}")
    }
}
