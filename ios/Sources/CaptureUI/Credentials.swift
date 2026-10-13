#if os(iOS)
import AuthenticationServices
import CaptureCore
import CryptoKit
import Security
import UIKit

@MainActor
final class OAuthConnection: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private let window: UIWindow
    init(window: UIWindow) { self.window = window }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }

    func connect(clientID: String, callbackScheme: String) async throws -> String {
        func random() throws -> String {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CaptureError.message("Could not begin a secure connection.") }
            return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let verifier = try random(), state = try random()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let redirect = "\(callbackScheme)://oauth"
        var url = URLComponents(string: "https://www.are.na/oauth/authorize")!
        url.queryItems = ["client_id": clientID, "redirect_uri": redirect, "response_type": "code", "scope": "write", "state": state, "code_challenge": challenge, "code_challenge_method": "S256"].map { .init(name: $0.key, value: $0.value) }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: callbackScheme) { result, error in
                if let result { continuation.resume(returning: result) }
                else { continuation.resume(throwing: error ?? CaptureError.message("Account connection was cancelled.")) }
            }
            session?.presentationContextProvider = self
            if session?.start() != true { continuation.resume(throwing: CaptureError.message("Could not open the account connection.")) }
        }
        defer { session = nil }
        let components = URLComponents(url: callback, resolvingAgainstBaseURL: false)
        let parameters = components?.queryItems ?? []
        guard callback.scheme == callbackScheme, callback.host == "oauth",
              parameters.filter({ $0.name == "state" }).count == 1,
              parameters.first(where: { $0.name == "state" })?.value == state,
              let code = parameters.first(where: { $0.name == "code" })?.value else {
            throw CaptureError.message("The account connection could not be verified. Please try again.")
        }
        var request = URLRequest(url: URL(string: "https://api.are.na/v3/oauth/token")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["grant_type": "authorization_code", "client_id": clientID, "redirect_uri": redirect, "code": code, "code_verifier": verifier])
        let (data, response) = try await CaptureTransport.session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              let token = try JSONDecoder().decode(JSONValue.self, from: data)["access_token"]?.string else {
            throw CaptureError.message("Are.na could not complete the account connection.")
        }
        return token
    }
}

#endif
