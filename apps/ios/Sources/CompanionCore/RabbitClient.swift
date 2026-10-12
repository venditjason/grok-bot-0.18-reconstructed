import Foundation

public enum RabbitRequestBuilder {
    public static func getRun(endpoint: RabbitEndpoint, runID: UUID, key: String) throws -> URLRequest {
        try RabbitEndpoint.validateKey(key)
        var request = URLRequest(url: endpoint.runURL(runID), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(key, forHTTPHeaderField: "X-Project-API-Key")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpShouldHandleCookies = false
        return request
    }
    public static func validateResponse(_ response: URLResponse, expectedURL: URL) throws {
        guard let response = response as? HTTPURLResponse, response.url == expectedURL else { throw CompanionError.invalidResponse }
        guard response.statusCode == 200 else { throw CompanionError.http(response.statusCode) }
        let mime = response.mimeType?.lowercased() ?? ""
        guard mime == "application/json" || mime.hasPrefix("application/") && mime.hasSuffix("+json") else { throw CompanionError.invalidResponse }
        guard response.expectedContentLength <= 1_048_576 else { throw CompanionError.oversizedResponse }
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Read-only transport. No owner cookies, vendor login tokens, redirects, or automatic polling.
public struct RabbitClient: Sendable {
    public init() {}
    public func getRun(endpoint: RabbitEndpoint, runID: UUID, key: String) async throws -> RunDetail {
        let request = try RabbitRequestBuilder.getRun(endpoint: endpoint, runID: runID, key: key)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            try RabbitRequestBuilder.validateResponse(response, expectedURL: request.url!)
            var data = Data()
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < 1_048_576 else { throw CompanionError.oversizedResponse }
                data.append(byte)
            }
            return try RunDetail.decode(data, endpoint: endpoint, runID: runID, key: key)
        } catch is CancellationError { throw CancellationError() }
          catch let error as CompanionError { throw error }
          catch { throw CompanionError.network }
    }
}
