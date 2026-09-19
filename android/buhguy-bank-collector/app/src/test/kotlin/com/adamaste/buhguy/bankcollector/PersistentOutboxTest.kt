package com.adamaste.buhguy.bankcollector

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.adamaste.buhguy.bankcollector.outbox.CollectorDatabase
import com.adamaste.buhguy.bankcollector.outbox.OutboxEntity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class PersistentOutboxTest {
    @Test fun duplicateEventIsIgnoredAndPendingSurvivesReopen() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "outbox-${UUID.randomUUID()}.db"
        val first = Room.databaseBuilder(context, CollectorDatabase::class.java, databaseName)
            .allowMainThreadQueries()
            .build()

        try {
            val event = OutboxEntity(
                sourceEventId = "source-event-1",
                packageName = "com.example.bank",
                eventJson = "{\"amount\":\"10\"}",
            )
            assertTrue(first.outbox().insert(event) > 0)
            assertEquals(-1L, first.outbox().insert(event))
            assertEquals(1, first.outbox().pendingCount())
            first.close()

            val reopened = Room.databaseBuilder(context, CollectorDatabase::class.java, databaseName)
                .allowMainThreadQueries()
                .build()
            try {
                val pending = reopened.outbox().pending(50)
                assertEquals(1, pending.size)
                assertEquals("source-event-1", pending.single().sourceEventId)
                assertEquals("PENDING", pending.single().status)
            } finally {
                reopened.close()
            }
        } finally {
            if (first.isOpen) first.close()
            context.deleteDatabase(databaseName)
        }
    }
}
