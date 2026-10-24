package app.tryliner.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

object LanControl {
    private const val DISCOVERY_PORT = 47901
    private const val HTTP_PORT = 47823
    private const val DISCOVERY_MESSAGE = "LINER_DISCOVER"
    private const val MAX_RESPONSE_BYTES = 512 * 1024

    fun discover(requestId: String): String {
        val hosts = JSONArray()
        try {
            DatagramSocket(null).use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(0))
                socket.broadcast = true
                socket.soTimeout = 250

                val targets = linkedSetOf("255.255.255.255")
                try {
                    val interfaces = NetworkInterface.getNetworkInterfaces()
                    while (interfaces.hasMoreElements()) {
                        val networkInterface = interfaces.nextElement()
                        if (!networkInterface.isUp || networkInterface.isLoopback) continue
                        for (interfaceAddress in networkInterface.interfaceAddresses) {
                            val broadcast = interfaceAddress.broadcast
                            if (broadcast is Inet4Address) {
                                broadcast.hostAddress?.let(targets::add)
                            }
                        }
                    }
                } catch (_: Exception) {
                }

                val message = DISCOVERY_MESSAGE.toByteArray(StandardCharsets.UTF_8)
                for (target in targets) {
                    try {
                        val address = InetAddress.getByName(target)
                        socket.send(DatagramPacket(message, message.size, address, DISCOVERY_PORT))
                    } catch (_: Exception) {
                    }
                }

                val found = linkedMapOf<String, JSONObject>()
                val deadline = System.currentTimeMillis() + 4_000
                while (System.currentTimeMillis() < deadline) {
                    val buffer = ByteArray(4096)
                    val packet = DatagramPacket(buffer, buffer.size)
                    try {
                        socket.receive(packet)
                    } catch (_: java.net.SocketTimeoutException) {
                        continue
                    }

                    val address = packet.address.hostAddress ?: continue
                    if (!isPrivateIpv4(address)) continue
                    try {
                        val payload = JSONObject(
                            String(packet.data, packet.offset, packet.length, StandardCharsets.UTF_8),
                        )
                        val port = payload.optInt("port", -1)
                        val token = payload.optString("token")
                        if (payload.optString("app") != "liner" ||
                            port != HTTP_PORT ||
                            !token.matches(Regex("[a-fA-F0-9]{32}"))
                        ) continue
                        found["$address:$port"] = JSONObject()
                            .put("name", payload.optString("name", "Liner").take(80))
                            .put("address", address)
                            .put("port", port)
                            .put("token", token)
                    } catch (_: Exception) {
                    }
                }
                found.values.forEach(hosts::put)
            }
            return JSONObject().put("id", requestId).put("hosts", hosts).toString()
        } catch (error: Exception) {
            return JSONObject()
                .put("id", requestId)
                .put("hosts", hosts)
                .put("error", error.message ?: "LAN discovery failed")
                .toString()
        }
    }

    fun request(requestId: String, method: String, url: String, body: String?): String {
        return try {
            val uri = URI(url)
            val host = uri.host ?: throw IllegalArgumentException("Invalid LAN host")
            if (uri.scheme != "http" ||
                uri.port != HTTP_PORT ||
                uri.rawUserInfo != null ||
                uri.rawFragment != null ||
                !isPrivateIpv4(host)
            ) throw IllegalArgumentException("Only discovered local Liner devices are allowed")

            val path = uri.rawPath
            if (path != "/offer" && path != "/answer") {
                throw IllegalArgumentException("Unsupported LAN request")
            }
            if ((path == "/offer" && method != "GET") ||
                (path == "/answer" && method != "POST")
            ) throw IllegalArgumentException("Unsupported LAN method")

            val token = uri.rawQuery
                ?.split("&")
                ?.firstOrNull { it.startsWith("key=") }
                ?.substringAfter("key=")
                ?.let { URLDecoder.decode(it, "UTF-8") }
                ?: throw IllegalArgumentException("Missing device discovery key")
            if (!token.matches(Regex("[a-fA-F0-9]{32}"))) {
                throw IllegalArgumentException("Invalid device discovery key")
            }

            val requestBody = body.orEmpty().toByteArray(StandardCharsets.UTF_8)
            if (requestBody.size > MAX_RESPONSE_BYTES) {
                throw IllegalArgumentException("LAN request body is too large")
            }
            val target = "$path?key=${token}"
            val requestHeaders = buildString {
                append("$method $target HTTP/1.1\r\n")
                append("Host: $host:$HTTP_PORT\r\n")
                append("Connection: close\r\n")
                append("Accept: application/json\r\n")
                if (method == "POST") {
                    append("Content-Type: text/plain; charset=utf-8\r\n")
                    append("Content-Length: ${requestBody.size}\r\n")
                }
                append("\r\n")
            }.toByteArray(StandardCharsets.US_ASCII)

            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, HTTP_PORT), 4_000)
                socket.soTimeout = 8_000
                socket.getOutputStream().apply {
                    write(requestHeaders)
                    if (requestBody.isNotEmpty()) write(requestBody)
                    flush()
                }
                val input = BufferedInputStream(socket.getInputStream())
                val statusLine = readHttpLine(input)
                val status = statusLine.split(" ").getOrNull(1)?.toIntOrNull()
                    ?: throw IllegalStateException("Invalid LAN response")
                var contentLength = -1
                var chunked = false
                while (true) {
                    val header = readHttpLine(input)
                    if (header.isEmpty()) break
                    val separator = header.indexOf(':')
                    if (separator < 0) continue
                    val name = header.substring(0, separator).trim()
                    val value = header.substring(separator + 1).trim()
                    if (name.equals("content-length", ignoreCase = true)) {
                        contentLength = value.toIntOrNull() ?: -1
                    }
                    if (name.equals("transfer-encoding", ignoreCase = true) &&
                        value.equals("chunked", ignoreCase = true)
                    ) chunked = true
                }
                if (chunked) throw IllegalStateException("Unexpected chunked LAN response")
                if (contentLength < 0 || contentLength > MAX_RESPONSE_BYTES) {
                    throw IllegalStateException("Invalid LAN response size")
                }
                val response = ByteArray(contentLength)
                var offset = 0
                while (offset < response.size) {
                    val read = input.read(response, offset, response.size - offset)
                    if (read < 0) throw IllegalStateException("Incomplete LAN response")
                    offset += read
                }
                JSONObject()
                    .put("id", requestId)
                    .put("status", status)
                    .put("body", String(response, StandardCharsets.UTF_8))
                    .toString()
            }
        } catch (error: Exception) {
            JSONObject()
                .put("id", requestId)
                .put("status", 0)
                .put("body", "")
                .put("error", error.message ?: "LAN request failed")
                .toString()
        }
    }

    private fun readHttpLine(input: BufferedInputStream): String {
        val bytes = ByteArrayOutputStream()
        while (bytes.size() <= 8_192) {
            val value = input.read()
            if (value < 0) throw IllegalStateException("Incomplete LAN response")
            if (value == '\n'.code) break
            if (value != '\r'.code) bytes.write(value)
        }
        if (bytes.size() > 8_192) throw IllegalStateException("LAN response header is too large")
        return bytes.toString("UTF-8")
    }

    private fun isPrivateIpv4(address: String): Boolean {
        val parts = address.split(".")
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        if (octets.any { it !in 0..255 }) return false
        return octets[0] == 10 ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            octets[0] == 127 ||
            (octets[0] == 169 && octets[1] == 254)
    }
}
