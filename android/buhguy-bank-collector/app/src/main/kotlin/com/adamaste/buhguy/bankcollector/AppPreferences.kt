package com.adamaste.buhguy.bankcollector

import android.content.Context

class AppPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("collector-config", Context.MODE_PRIVATE)
    private val packageName = context.packageName
    fun sourceKey(): String = preferences.getString("sourceKey", "android-$packageName")!!
    fun allowedPackages(): Set<String> = preferences.getStringSet("allowedPackages", emptySet()) ?: emptySet()
    fun serverUrl(): String = preferences.getString("serverUrl", "")!!
    fun lastSuccessfulDelivery(): String = preferences.getString("lastSuccessfulDelivery", "never")!!
    fun save(serverUrl: String, sourceKey: String, allowedPackages: Set<String>) {
        preferences.edit().putString("serverUrl", serverUrl.trim()).putString("sourceKey", sourceKey.trim())
            .putStringSet("allowedPackages", allowedPackages.map(String::trim).filter(String::isNotEmpty).toSet()).apply()
    }

    fun markSuccessfulDelivery(timestamp: String) = preferences.edit().putString("lastSuccessfulDelivery", timestamp).apply()
}
