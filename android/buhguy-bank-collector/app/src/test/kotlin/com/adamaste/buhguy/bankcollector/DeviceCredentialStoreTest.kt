package com.adamaste.buhguy.bankcollector

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import javax.crypto.spec.SecretKeySpec

@RunWith(RobolectricTestRunner::class)
class DeviceCredentialStoreTest {
    @Test fun tokenIsEncryptedAtRestAndClearedWithoutPlaintextPreferences() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val token = "bg1.credential-key.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12"
        val testKey = SecretKeySpec(ByteArray(32) { it.toByte() }, "AES")
        val store = DeviceCredentialStore(context, testKeyProvider = { testKey })

        store.clear()
        store.save(token)

        assertEquals(token, store.read())
        assertFalse(context.getSharedPreferences("collector-config", Context.MODE_PRIVATE).all.values.contains(token))
        assertNotEquals(token, context.getSharedPreferences(DeviceCredentialStore.PREFERENCES_NAME, Context.MODE_PRIVATE).getString("encrypted-token", null))
        assertEquals("Bearer $token", store.authorizationHeader())

        store.clear()
        assertEquals(null, store.read())
    }
}
