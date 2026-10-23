import Foundation

enum HttpProxy {
    static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    private static let maxBodyBytes = 12_000_000

    private static let allowedHosts: Set<String> = [
        "api.tryliner.fun",
        "covers.tryliner.fun",
        "link.tryliner.fun",
        "www.youtube.com",
        "youtube.com",
        "music.youtube.com",
        "youtubei.googleapis.com",
    ]

    private static let allowedSuffixes = [
        ".googlevideo.com",
        ".ytimg.com",
        ".googleusercontent.com",
        ".ggpht.com",
        ".sndcdn.com",
    ]

    private static let blockedHeaders: Set<String> = [
        "host", "connection", "content-length", "accept-encoding",
        "origin", "referer", "cookie", "sec-fetch-mode", "sec-fetch-site",
    ]

    private static let cacheDirectory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("http_cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(
            memoryCapacity: 16 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024,
            directory: cacheDirectory
        )
        configuration.requestCachePolicy = .useProtocolCachePolicy
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        return URLSession(configuration: configuration)
    }()

    static var diskUsage: Int64 {
        Int64(session.configuration.urlCache?.currentDiskUsage ?? 0)
    }

    static func clearCache() {
        session.configuration.urlCache?.removeAllCachedResponses()
    }

    static func isAllowed(host: String) -> Bool {
        let normalized = host.lowercased()
        if allowedHosts.contains(normalized) { return true }
        return allowedSuffixes.contains { normalized.hasSuffix($0) }
    }

    static func request(
        id: String,
        method: String,
        url: String,
        headersJSON: String,
        body: String?
    ) {
        guard
            let parsed = URL(string: url),
            parsed.scheme?.lowercased() == "https",
            let host = parsed.host,
            isAllowed(host: host)
        else {
            emit(id: id, json: errorPayload(id: id, message: "Blocked host: \(URL(string: url)?.host ?? "")"))
            return
        }

        var request = URLRequest(url: parsed)
        request.httpMethod = method.uppercased()

        var hasUserAgent = false
        if let data = headersJSON.data(using: .utf8),
           let raw = try? JSONSerialization.jsonObject(with: data),
           let headers = raw as? [String: Any] {
            for (key, value) in headers {
                let lower = key.lowercased()
                if blockedHeaders.contains(lower) { continue }
                if lower == "user-agent" { hasUserAgent = true }
                let text: String
                if let string = value as? String {
                    text = string
                } else if let number = value as? NSNumber {
                    text = number.stringValue
                } else {
                    continue
                }
                request.setValue(text, forHTTPHeaderField: key)
            }
        }

        if !hasUserAgent {
            request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        }
        request.setValue("en-US,en;q=0.9", forHTTPHeaderField: "Accept-Language")

        if host.lowercased().hasSuffix("youtube.com") {
            request.setValue("https://\(host)", forHTTPHeaderField: "Origin")
            request.setValue("https://\(host)/", forHTTPHeaderField: "Referer")
        }

        if request.httpMethod != "GET" && request.httpMethod != "HEAD" {
            request.httpBody = (body ?? "").data(using: .utf8)
            if request.value(forHTTPHeaderField: "Content-Type") == nil {
                request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            }
        }

        session.dataTask(with: request) { data, response, error in
            if let error {
                emit(id: id, json: errorPayload(id: id, message: error.localizedDescription))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                emit(id: id, json: errorPayload(id: id, message: "Network request failed"))
                return
            }
            let payload = data ?? Data()
            if payload.count > maxBodyBytes {
                emit(id: id, json: errorPayload(id: id, message: "Response too large"))
                return
            }

            let text = String(data: payload, encoding: .utf8) ?? ""
            let headers: [String: String] = [
                "content-type": http.value(forHTTPHeaderField: "Content-Type") ?? "",
                "date": http.value(forHTTPHeaderField: "Date") ?? "",
                "location": http.value(forHTTPHeaderField: "Location") ?? "",
                "x-request-id": http.value(forHTTPHeaderField: "x-request-id") ?? "",
                "x-liner-server-time": http.value(forHTTPHeaderField: "x-liner-server-time") ?? "",
            ]
            let result: [String: Any] = [
                "id": id,
                "status": http.statusCode,
                "ok": (200...299).contains(http.statusCode),
                "headers": headers,
                "body": text,
            ]
            guard
                JSONSerialization.isValidJSONObject(result),
                let encoded = try? JSONSerialization.data(withJSONObject: result),
                let json = String(data: encoded, encoding: .utf8)
            else {
                emit(id: id, json: errorPayload(id: id, message: "Could not encode response"))
                return
            }
            emit(id: id, json: json)
        }.resume()
    }

    static func downloadAudio(id: String, url: String, filename: String, mimeType: String) {
        guard
            let parsed = URL(string: url),
            parsed.scheme?.lowercased() == "https",
            let host = parsed.host,
            isAllowed(host: host)
        else {
            emitDownload(id: id, json: downloadError(id: id, message: "Blocked host"))
            return
        }

        var request = URLRequest(url: parsed)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        session.downloadTask(with: request) { location, response, error in
            if let error {
                emitDownload(id: id, json: downloadError(id: id, message: error.localizedDescription))
                return
            }
            guard
                let location,
                let http = response as? HTTPURLResponse,
                (200...299).contains(http.statusCode)
            else {
                emitDownload(id: id, json: downloadError(id: id, message: "Download failed"))
                return
            }

            let fallbackExtension = mimeType.contains("mpeg") ? "mp3" : "m4a"
            let name = safeFileName(filename, fallbackExtension: fallbackExtension)
            let destination = FileManager.default
                .urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Downloads", isDirectory: true)
                .appendingPathComponent(name)

            do {
                try FileManager.default.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.moveItem(at: location, to: destination)
                let payload: [String: Any] = [
                    "id": id,
                    "success": true,
                    "filePath": destination.path,
                ]
                emitDownload(id: id, json: encode(payload) ?? downloadError(id: id, message: "Could not encode result"))
            } catch {
                emitDownload(id: id, json: downloadError(id: id, message: error.localizedDescription))
            }
        }.resume()
    }

    static func saveDump(filename: String, content: String) -> String {
        let name = safeFileName(filename, fallbackExtension: "json")
        let destination = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Downloads", isDirectory: true)
            .appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try content.write(to: destination, atomically: true, encoding: .utf8)
            return encode(["success": true, "filePath": destination.path])
                ?? "{\"success\":true}"
        } catch {
            return encode(["success": false, "error": error.localizedDescription])
                ?? "{\"success\":false}"
        }
    }

    static func directorySize(_ url: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.fileSizeKey]
        ) else { return 0 }

        var total: Int64 = 0
        for case let file as URL in enumerator {
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            total += Int64(size)
        }
        return total
    }


    private static func emit(id: String, json: String) {
        LinerHost.shared.emit("httpResponse", json)
    }

    private static func emitDownload(id: String, json: String) {
        LinerHost.shared.emit("audioDownload", json)
    }

    private static func errorPayload(id: String, message: String) -> String {
        encode([
            "id": id,
            "status": 0,
            "ok": false,
            "error": message,
        ]) ?? "{\"id\":\"\",\"status\":0,\"ok\":false}"
    }

    private static func downloadError(id: String, message: String) -> String {
        encode([
            "id": id,
            "success": false,
            "error": message,
        ]) ?? "{\"success\":false}"
    }

    private static func encode(_ object: [String: Any]) -> String? {
        guard
            JSONSerialization.isValidJSONObject(object),
            let data = try? JSONSerialization.data(withJSONObject: object)
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func safeFileName(_ raw: String, fallbackExtension: String) -> String {
        let cleaned: [Character] = raw.map { character in
            if character.isLetter || character.isNumber
                || character == "." || character == "_" || character == "-" {
                return character
            }
            return "_"
        }
        var name = String(cleaned.prefix(120))
        if name.isEmpty {
            name = "liner-\(Int(Date().timeIntervalSince1970))"
        }
        if !name.contains(".") {
            name = "\(name).\(fallbackExtension)"
        }
        return name
    }
}
