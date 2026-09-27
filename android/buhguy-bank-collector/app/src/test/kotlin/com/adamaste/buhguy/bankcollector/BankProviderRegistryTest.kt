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
    @Test fun configuredYandexAllowsOnlyTheScopedTransportAlias() {
        val registry = BankProviderRegistry.fromPackageAllowlist(setOf("com.yandex.bank"))

        val direct = registry.match("com.yandex.bank", null)
        val alias = registry.match("ru.yandex.taximeter", "notification_channel_1")
        val wrongChannel = registry.match("ru.yandex.taximeter", "other")
        val genericAlias = BankProviderRegistry.fromPackageAllowlist(setOf("ru.yandex.taximeter"))

        assertEquals("com.yandex.bank", direct?.provider?.providerKey)
        assertEquals("com.yandex.bank", alias?.provider?.providerKey)
        assertEquals(true, alias?.requiresClassifier)
        assertEquals(null, wrongChannel)
        assertEquals(null, genericAlias.match("ru.yandex.taximeter", "notification_channel_1"))
    }

    @Test fun unrelatedPackageWithYandexChannelIsRejected() {
        val registry = BankProviderRegistry.fromPackageAllowlist(setOf("com.yandex.bank"))

        assertEquals(null, registry.match("com.example.other", "notification_channel_1"))
    }

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
