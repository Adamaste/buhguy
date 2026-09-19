package com.adamaste.buhguy.bankcollector

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceCredentialStore(
    context: Context,
    private val keyProvider: () -> SecretKey = { androidKey() },
) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun save(token: String) {
        require(token.matches(Regex("bg1\\.[A-Za-z0-9_-]{8,64}\\.[A-Za-z0-9_-]{43}"))) { "Invalid device credential" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider())
        val blob = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        preferences.edit().putString(TOKEN_BLOB_KEY, Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
    }

    fun read(): String? {
        val encoded = preferences.getString(TOKEN_BLOB_KEY, null) ?: return null
        val blob = Base64.decode(encoded, Base64.NO_WRAP)
        if (blob.size <= IV_LENGTH) return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(TAG_LENGTH_BITS, blob.copyOf(IV_LENGTH)))
        return cipher.doFinal(blob.copyOfRange(IV_LENGTH, blob.size)).toString(Charsets.UTF_8)
    }

    fun authorizationHeader(): String? = read()?.let { "Bearer $it" }
    fun isConfigured(): Boolean = preferences.contains(TOKEN_BLOB_KEY)
    fun clear() = preferences.edit().remove(TOKEN_BLOB_KEY).apply()

    private fun androidKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        return KeyGenerator.getInstance(KEY_ALGORITHM, ANDROID_KEYSTORE).apply {
            init(android.security.keystore.KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    companion object {
        const val PREFERENCES_NAME = "device-credential-secure"
        private const val TOKEN_BLOB_KEY = "encrypted-token"
        private const val KEY_ALIAS = "buhguy-bank-device-credential"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALGORITHM = "AES"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_LENGTH = 12
        private const val TAG_LENGTH_BITS = 128
    }
}

class KeystoreAuthHeaderProvider(context: Context) : com.adamaste.buhguy.bankcollector.delivery.AuthHeaderProvider {
    private val store = DeviceCredentialStore(context.applicationContext)
    override fun authorizationHeader(): String? = store.authorizationHeader()
}
