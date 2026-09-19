package com.adamaste.buhguy.bankcollector

import android.app.Application
import androidx.room.Room
import com.adamaste.buhguy.bankcollector.delivery.BankTransport
import com.adamaste.buhguy.bankcollector.delivery.HttpBankTransport
import com.adamaste.buhguy.bankcollector.delivery.TransportResult
import com.adamaste.buhguy.bankcollector.outbox.CollectorDatabase

class BankCollectorApplication : Application() {
    val database: CollectorDatabase by lazy { Room.databaseBuilder(this, CollectorDatabase::class.java, "bank-collector.db").build() }
    val transport: BankTransport
        get() {
            val url = AppPreferences(this).serverUrl()
            return if (url.isBlank()) {
                object : BankTransport {
                    override suspend fun send(eventJson: String): TransportResult =
                        TransportResult(null, networkFailure = true)
                }
            } else {
                HttpBankTransport(url)
            }
        }
}
