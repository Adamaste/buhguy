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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

@RunWith(RobolectricTestRunner::class)
class PersistentOutboxTest {
    @Test fun pendingCountFlowTracksInsertAndTerminalStatuses() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "outbox-flow-${UUID.randomUUID()}.db"
        val database = Room.databaseBuilder(context, CollectorDatabase::class.java, databaseName)
            .allowMainThreadQueries()
            .build()
        try {
            val dao = database.outbox()
            assertEquals(0, dao.pendingCountFlow().first())
            val event = OutboxEntity(sourceEventId = "flow-event", packageName = "com.example.bank", eventJson = "{}")
            val firstId = dao.insert(event)
            assertEquals(1, dao.pendingCountFlow().first())
            dao.setStatus(firstId, "SENT")
            assertEquals(0, dao.pendingCountFlow().first())
            val secondId = dao.insert(event.copy(sourceEventId = "flow-event-2"))
            dao.setStatus(secondId, "PERMANENTLY_REJECTED")
            assertEquals(0, dao.pendingCountFlow().first())
        } finally {
            database.close()
            context.deleteDatabase(databaseName)
        }
    }

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
                eventJson = "{\"sourceEventId\":\"source-event-1\",\"payload\":{\"amount\":\"10.00\"}}",
            )
            val eventRowId = first.outbox().insert(event)
            assertTrue(eventRowId > 0)
            first.outbox().markRetry(eventRowId, "transient delivery failure")
            val retried = first.outbox().pending(50).single()
            assertEquals("PENDING", retried.status)
            assertEquals(1, retried.retryCount)
            assertEquals(event.sourceEventId, retried.sourceEventId)
            assertEquals(event.eventJson, retried.eventJson)
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
                assertEquals(1, pending.single().retryCount)
                assertEquals(event.eventJson, pending.single().eventJson)
            } finally {
                reopened.close()
            }
        } finally {
            if (first.isOpen) first.close()
            context.deleteDatabase(databaseName)
        }
    }
}
