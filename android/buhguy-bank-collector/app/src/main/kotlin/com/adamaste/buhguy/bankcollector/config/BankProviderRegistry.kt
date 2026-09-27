package com.adamaste.buhguy.bankcollector.config

data class BankProviderConfig(
    val providerKey: String,
    val displayName: String,
    val packageNames: Set<String>,
    val parserStrategy: ParserStrategy = ParserStrategy.RAW_ONLY,
)

data class NotificationSourceMatch(
    val provider: BankProviderConfig,
    val requiresClassifier: Boolean,
)

enum class ParserStrategy { RAW_ONLY }

class BankProviderRegistry(configs: List<BankProviderConfig>) {
    private val byPackage = configs.flatMap { config -> config.packageNames.map { it to config } }.toMap()
    private val yandexAliasEnabled = configs.any {
        it.providerKey == YANDEX_BANK_PROVIDER && it.packageNames.contains(YANDEX_BANK_PROVIDER)
    }

    fun providerFor(packageName: String): BankProviderConfig? = byPackage[packageName]
    fun isAllowed(packageName: String): Boolean = providerFor(packageName) != null

    fun match(packageName: String, channelId: String?): NotificationSourceMatch? {
        providerFor(packageName)?.let { return NotificationSourceMatch(it, requiresClassifier = false) }
        if (yandexAliasEnabled && packageName == YANDEX_PRO_TRANSPORT_PACKAGE && channelId == YANDEX_PRO_FINANCIAL_CHANNEL) {
            return NotificationSourceMatch(
                provider = BankProviderConfig(YANDEX_BANK_PROVIDER, YANDEX_BANK_PROVIDER, setOf(YANDEX_PRO_TRANSPORT_PACKAGE)),
                requiresClassifier = true,
            )
        }
        return null
    }

    companion object {
        fun fromPackageAllowlist(packageNames: Set<String>): BankProviderRegistry = BankProviderRegistry(
            packageNames.sorted().filterNot { it == YANDEX_PRO_TRANSPORT_PACKAGE }.map { packageName ->
                BankProviderConfig(
                    providerKey = packageName,
                    displayName = packageName,
                    packageNames = setOf(packageName),
                )
            },
        )
    }
}

const val YANDEX_BANK_PROVIDER = "com.yandex.bank"
const val YANDEX_PRO_TRANSPORT_PACKAGE = "ru.yandex.taximeter"
const val YANDEX_PRO_FINANCIAL_CHANNEL = "notification_channel_1"
