package com.adamaste.buhguy.bankcollector.notification

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/** Stores opaque per-posting lifecycle IDs; the Android notification key never leaves this process. */
class NotificationLifecycleStore(
    context: Context,
    private val testKeyProvider: (() -> SecretKey)? = null,
) {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    fun lifecycleId(notificationKey: String?): String? {
        val storageKey = storageKey(notificationKey) ?: return null
        synchronized(lock) {
            preferences.getString(storageKey, null)?.takeIf(UUID_PATTERN::matches)?.let { return it }
            val id = UUID.randomUUID().toString()
            return if (preferences.edit().putString(storageKey, id).commit()) id else null
        }
    }

    fun finishLifecycle(notificationKey: String?) {
        val storageKey = storageKey(notificationKey) ?: return
        synchronized(lock) { preferences.edit().remove(storageKey).commit() }
    }

    fun retainActiveNotificationKeys(notificationKeys: Collection<String?>) {
        val active = notificationKeys.mapNotNull(::storageKey).toSet()
        synchronized(lock) {
            val editor = preferences.edit()
            var changed = false
            preferences.all.keys.filter { it.startsWith(KEY_PREFIX) && it !in active }.forEach {
                editor.remove(it)
                changed = true
            }
            if (changed) editor.commit()
        }
    }

    private fun storageKey(notificationKey: String?): String? {
        if (notificationKey.isNullOrBlank()) return null
        return try {
            val mac = Mac.getInstance(HMAC_ALGORITHM)
            mac.init(testKeyProvider?.invoke() ?: androidKey())
            KEY_PREFIX + Base64.encodeToString(
                mac.doFinal(notificationKey.toByteArray(Charsets.UTF_8)),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun androidKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(HMAC_ALGORITHM, ANDROID_KEYSTORE).apply {
            init(KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            ).setDigests(KeyProperties.DIGEST_SHA256).build())
        }.generateKey()
    }

    companion object {
        const val PREFERENCES_NAME = "notification-lifecycle-v1"
        private const val KEY_PREFIX = "hmac:"
        private const val KEY_ALIAS = "buhguy-notification-lifecycle-hmac-v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val HMAC_ALGORITHM = "HmacSHA256"
        private val UUID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
    }
}
