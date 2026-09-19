package com.adamaste.buhguy.bankcollector.config

data class BankProviderConfig(
    val providerKey: String,
    val displayName: String,
    val packageNames: Set<String>,
    val parserStrategy: ParserStrategy = ParserStrategy.RAW_ONLY,
)

enum class ParserStrategy { RAW_ONLY }

class BankProviderRegistry(configs: List<BankProviderConfig>) {
    private val byPackage = configs.flatMap { config -> config.packageNames.map { it to config } }.toMap()

    fun providerFor(packageName: String): BankProviderConfig? = byPackage[packageName]
    fun isAllowed(packageName: String): Boolean = providerFor(packageName) != null

    companion object {
        fun fromPackageAllowlist(packageNames: Set<String>): BankProviderRegistry = BankProviderRegistry(
            listOf(BankProviderConfig("configured", "Configured bank", packageNames)),
        )
    }
}
