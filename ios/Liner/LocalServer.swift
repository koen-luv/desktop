import Foundation
import Network

final class LocalServer {
    static let shared = LocalServer()

    private let queue = DispatchQueue(label: "app.tryliner.ios.localserver")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    private var root: URL {
        let base = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        return base.appendingPathComponent("Web", isDirectory: true)
    }

    func start() throws -> UInt16 {
        if port != 0 { return port }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: .any)

        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed:
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        _ = ready.wait(timeout: .now() + 5)
        guard let resolved = listener.port?.rawValue, resolved != 0 else {
            listener.cancel()
            throw NSError(
                domain: "app.tryliner.ios",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Loopback server failed to start"]
            )
        }

        self.listener = listener
        self.port = resolved
        return resolved
    }


    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] chunk, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }
            var accumulated = buffer
            if let chunk { accumulated.append(chunk) }

            if let separator = accumulated.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: accumulated[accumulated.startIndex..<separator.lowerBound], as: UTF8.self)
                self.respond(connection, head: head)
                return
            }
            if error != nil || isComplete || accumulated.count > 128 * 1024 {
                connection.cancel()
                return
            }
            self.receive(connection, buffer: accumulated)
        }
    }


    private func respond(_ connection: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            connection.cancel()
            return
        }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            connection.cancel()
            return
        }

        let method = String(parts[0]).uppercased()
        if method != "GET" && method != "HEAD" {
            send(connection, status: 405, headers: ["Allow": "GET, HEAD"], body: Data(), headOnly: false)
            return
        }

        var path = String(parts[1])
        if let query = path.firstIndex(of: "?") { path = String(path[..<query]) }
        path = path.removingPercentEncoding ?? path
        if path.isEmpty || path == "/" { path = "/index.html" }

        var rangeHeader: String?
        for line in lines.dropFirst() {
            if line.lowercased().hasPrefix("range:") {
                rangeHeader = String(line.dropFirst("range:".count)).trimmingCharacters(in: .whitespaces)
            }
        }

        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let fileURL = root.appendingPathComponent(relative).standardizedFileURL
        let rootPath = root.standardizedFileURL.path
        guard fileURL.path.hasPrefix(rootPath) else {
            send(connection, status: 403, headers: [:], body: Data("Forbidden".utf8), headOnly: false)
            return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            send(connection, status: 404, headers: [:], body: Data("Not found".utf8), headOnly: false)
            return
        }

        let cacheControl = relative == "index.html" ? "no-store" : "no-cache"
        var headers: [String: String] = [
            "Content-Type": Self.mimeType(forExtension: fileURL.pathExtension),
            "Cache-Control": cacheControl,
            "Accept-Ranges": "bytes",
        ]

        if method == "HEAD" {
            headers["Content-Length"] = String(data.count)
            send(connection, status: 200, headers: headers, body: Data(), headOnly: true)
            return
        }

        if let rangeHeader, let range = Self.parseRange(rangeHeader, total: data.count) {
            let slice = data.subdata(in: range)
            headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(data.count)"
            headers["Content-Length"] = String(slice.count)
            send(connection, status: 206, headers: headers, body: slice, headOnly: false)
            return
        }

        send(connection, status: 200, headers: headers, body: data, headOnly: false)
    }

    private func send(
        _ connection: NWConnection,
        status: Int,
        headers: [String: String],
        body: Data,
        headOnly: Bool
    ) {
        var head = "HTTP/1.1 \(status) \(Self.statusText(status))\r\n"
        for (key, value) in headers {
            head += "\(key): \(value)\r\n"
        }
        if headers["Content-Length"] == nil {
            head += "Content-Length: \(body.count)\r\n"
        }
        head += "Connection: close\r\n\r\n"

        var payload = Data(head.utf8)
        if !headOnly { payload.append(body) }

        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }


    private static func parseRange(_ header: String, total: Int) -> Range<Int>? {
        guard total > 0 else { return nil }
        let value = header.replacingOccurrences(of: "bytes=", with: "", options: [.caseInsensitive])
        let bounds = value.split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2 else { return nil }

        let lower: Int
        let upper: Int
        if bounds[0].isEmpty {
            guard let suffix = Int(bounds[1]), suffix > 0 else { return nil }
            lower = max(0, total - suffix)
            upper = total
        } else {
            guard let start = Int(bounds[0]) else { return nil }
            lower = min(max(0, start), total - 1)
            if bounds[1].isEmpty {
                upper = total
            } else {
                guard let end = Int(bounds[1]) else { return nil }
                upper = min(max(lower + 1, end + 1), total)
            }
        }
        guard lower < upper else { return nil }
        return lower..<upper
    }

    private static func statusText(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 206: return "Partial Content"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        default: return "OK"
        }
    }

    static func mimeType(forExtension pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "mp4": return "video/mp4"
        case "map": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
