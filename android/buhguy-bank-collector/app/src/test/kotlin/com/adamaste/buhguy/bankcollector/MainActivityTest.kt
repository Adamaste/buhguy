package com.adamaste.buhguy.bankcollector

import android.content.Context
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    @Test fun diagnosticReportIsReachableInsideScrollableContent() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val screenContent = LinearLayout(context)
        val scrollView = scrollableScreen(context, screenContent)

        assertTrue("Activity content should scroll on small screens", scrollView.isFillViewport)
        assertEquals(1, scrollView.childCount)
        assertSame(screenContent, scrollView.getChildAt(0))
    }
}
