package com.adamaste.buhguy.bankcollector

import com.adamaste.buhguy.bankcollector.config.BankProviderRegistry
import com.adamaste.buhguy.bankcollector.delivery.DeliveryDecision
import com.adamaste.buhguy.bankcollector.delivery.TransportConfigurationException
import com.adamaste.buhguy.bankcollector.delivery.deliveryDecision
import com.adamaste.buhguy.bankcollector.delivery.transportFailureResult
import com.adamaste.buhguy.bankcollector.notification.NotificationEventMapper
import com.adamaste.buhguy.bankcollector.notification.NotificationSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class BankProviderRegistryTest {
    @Test fun configuredPackagesKeepDistinctProviderMetadata() {
        val registry = BankProviderRegistry.fromPackageAllowlist(
            setOf("com.example.bank.one", "com.example.bank.two"),
        )
        val mapper = NotificationEventMapper(registry, "android-test")

        val first = mapper.map(NotificationSnapshot("com.example.bank.one", null, 1, null, 1L, "a", "b", null, null))!!
        val second = mapper.map(NotificationSnapshot("com.example.bank.two", null, 1, null, 1L, "a", "b", null, null))!!

        assertEquals("com.example.bank.one", first.ingestionMetadata["provider"])
        assertEquals("com.example.bank.two", second.ingestionMetadata["provider"])
        assertNotEquals(first.ingestionMetadata["provider"], second.ingestionMetadata["provider"])
    }

    @Test fun invalidTransportConfigurationRemainsRetryable() {
        val result = transportFailureResult(TransportConfigurationException("HTTPS URL is not configured"))

        assertEquals(DeliveryDecision.Retry, deliveryDecision(result.httpStatus, result.networkFailure, result.serverStatus))
    }
}
