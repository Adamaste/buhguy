package com.adamaste.buhguy.bankcollector.outbox

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import com.adamaste.buhguy.bankcollector.model.OutboxEvent
import com.adamaste.buhguy.bankcollector.model.OutboxStatus

@Entity(tableName = "bank_notification_outbox", indices = [Index(value = ["sourceEventId"], unique = true)])
data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sourceEventId: String,
    val packageName: String,
    val eventJson: String,
    val status: String = OutboxStatus.PENDING.name,
    val retryCount: Int = 0,
    val lastError: String? = null,
)

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(event: OutboxEntity): Long

    @Query("SELECT * FROM bank_notification_outbox WHERE status = 'PENDING' ORDER BY id LIMIT :limit")
    suspend fun pending(limit: Int): List<OutboxEntity>

    @Query("UPDATE bank_notification_outbox SET status = :status, lastError = :error WHERE id = :id")
    suspend fun setStatus(id: Long, status: String, error: String? = null)

    @Query("UPDATE bank_notification_outbox SET retryCount = retryCount + 1, lastError = :error WHERE id = :id")
    suspend fun markRetry(id: Long, error: String)

    @Query("UPDATE bank_notification_outbox SET lastError = :error WHERE id = :id")
    suspend fun markPendingIssue(id: Long, error: String)

    @Query("SELECT count(*) FROM bank_notification_outbox WHERE status = 'PENDING'")
    suspend fun pendingCount(): Int
}

@Database(entities = [OutboxEntity::class], version = 1, exportSchema = false)
abstract class CollectorDatabase : RoomDatabase() {
    abstract fun outbox(): OutboxDao
}

fun OutboxEntity.toModel() = OutboxEvent(id, sourceEventId, packageName, eventJson, OutboxStatus.valueOf(status), retryCount)
