package com.adamaste.buhguy.bankcollector.delivery

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.net.HttpURLConnection
import java.net.URI

interface AuthHeaderProvider {
    fun authorizationHeader(): String?
}

class TransportConfigurationException(message: String) : IllegalArgumentException(message)

class NoAuthHeaderProvider : AuthHeaderProvider {
    override fun authorizationHeader(): String? = null
}

class HttpBankTransport(
    private val serverUrl: String,
    private val authHeaderProvider: AuthHeaderProvider = NoAuthHeaderProvider(),
) : BankTransport {
    override suspend fun send(eventJson: String): TransportResult {
        val uri = URI(serverUrl)
        if (uri.scheme != "https") throw TransportConfigurationException("Production bank delivery requires HTTPS")
        val connection = (uri.toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            authHeaderProvider.authorizationHeader()?.let { setRequestProperty("Authorization", it) }
        }
        return try {
            connection.outputStream.use { it.write(eventJson.toByteArray(Charsets.UTF_8)) }
            val statusCode = connection.responseCode
            val body = runCatching {
                (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() }
            }.getOrNull()
            val serverStatus = body?.let { runCatching { Json.parseToJsonElement(it).jsonObject["status"]?.toString()?.trim('"') }.getOrNull() }
            TransportResult(statusCode, serverStatus)
        } finally {
            connection.disconnect()
        }
    }
}
