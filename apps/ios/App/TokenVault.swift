import Foundation
import Security

/// Only Rabbit project keys are accepted; Apple/OpenAI/Claude credentials are not imported.
struct TokenVault {
    private let service = "com.vendit.venditbot.companion.rabbit"
    private func query(_ endpoint: RabbitEndpoint) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: endpoint.credentialAccount]
    }
    func save(_ key: String, endpoint: RabbitEndpoint) throws {
        try RabbitEndpoint.validateKey(key)
        let query = query(endpoint)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess
            else { throw CompanionError.credentialsUnavailable }
        } else if status != errSecSuccess { throw CompanionError.credentialsUnavailable }
    }
    func read(endpoint: RabbitEndpoint) throws -> String {
        var request = query(endpoint)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let key = String(data: data, encoding: .utf8) else {
            throw CompanionError.credentialsUnavailable
        }
        try RabbitEndpoint.validateKey(key)
        return key
    }
    func delete(endpoint: RabbitEndpoint) throws {
        let result = SecItemDelete(query(endpoint) as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw CompanionError.credentialsUnavailable }
    }
}
