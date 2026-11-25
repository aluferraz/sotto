import Foundation
import Security

/// The API key, kept in the Mac's keychain and nowhere else.
///
/// The keychain is only touched when it has to be: when the API is the selected engine, or
/// while the user is setting it up. Someone who only uses the on-device model never sees a
/// keychain question from Sotto.
final class ApiKeyStore: ObservableObject {
    static let shared = ApiKeyStore()

    /// The key as last read or saved. Empty until `load()` has run, or when there is none.
    @Published private(set) var key = ""
    private var loaded = false

    private let query: [String: Any]

    /// `account` names the keychain item; only the self-test uses another one.
    init(account: String = "openai-compatible-api-key") {
        query = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.sotto.Sotto",
            kSecAttrAccount as String: account,
        ]
    }

    /// Reads the key from the keychain, once.
    func load() {
        guard !loaded else { return }
        loaded = true
        var item: CFTypeRef?
        let lookup = query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { $1 }
        if SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
            key = String(decoding: data, as: UTF8.self)
        }
    }

    /// Stores the key, or removes it when it is empty. Returns false if the keychain refused.
    @discardableResult
    func save(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        loaded = true
        guard trimmed != key else { return true }
        var status: OSStatus
        if trimmed.isEmpty {
            status = SecItemDelete(query as CFDictionary)
            if status == errSecItemNotFound { status = errSecSuccess }
        } else {
            let data = Data(trimmed.utf8)
            status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging([kSecValueData as String: data]) { $1 } as CFDictionary, nil)
            }
        }
        if status == errSecSuccess { key = trimmed }
        return status == errSecSuccess
    }
}
