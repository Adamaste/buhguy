package com.adamaste.buhguy.bankcollector

import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
class MainActivityLiveDiagnosticsTest {
    @Test fun preferencesRefreshWhileActivityRemainsAlive() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.getSharedPreferences("collector-config", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        try {
            ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
            val diagnostics = controller.get().findViewByTag("diagnostics")
            assertTrue(diagnostics.text.toString().contains("Last capture:"))
            AppPreferences(context).markLastCapture("time", "com.example.bank", "CAPTURED", "abcdef123456")
            ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
            assertTrue(diagnostics.text.toString().contains("CAPTURED com.example.bank abcdef123456"))
        } finally {
            controller.pause().stop().destroy()
        }
    }

    private fun MainActivity.findViewByTag(tag: String): TextView =
        window.decorView.findViewWithTag(tag)
}
