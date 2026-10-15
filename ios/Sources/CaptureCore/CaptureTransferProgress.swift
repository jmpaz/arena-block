import Foundation

public struct CaptureTransferProgress: Codable, Equatable, Sendable {
    public var transferID: String
    public var completedBytes: Int64
    public var expectedBytes: Int64?
    public var observedAt: Date
    public var waitingForConnectivity: Bool
    public var stage: CaptureDeliveryStage?

    public init(transferID: String, completedBytes: Int64, expectedBytes: Int64?, observedAt: Date = Date(), waitingForConnectivity: Bool = false, stage: CaptureDeliveryStage? = nil) {
        self.transferID = transferID; self.completedBytes = max(0, completedBytes)
        self.expectedBytes = expectedBytes.flatMap { $0 > 0 ? $0 : nil }
        self.observedAt = observedAt; self.waitingForConnectivity = waitingForConnectivity
        self.stage = stage
    }

    public var fraction: Double? {
        guard let expectedBytes, expectedBytes > 0 else { return nil }
        return min(1, Double(completedBytes) / Double(expectedBytes))
    }
}

public enum CaptureInterruptionReason: String, Codable, Sendable {
    case userPause, continuedTaskEnded, executionClaimLost
}

public struct CaptureInterruption: Codable, Equatable, Sendable {
    public var reason: CaptureInterruptionReason
    public var stage: CaptureDeliveryStage
    public var observedAt: Date
    public var transferID: String?
    public init(reason: CaptureInterruptionReason, stage: CaptureDeliveryStage, observedAt: Date = Date(), transferID: String? = nil) {
        self.reason = reason; self.stage = stage; self.observedAt = observedAt; self.transferID = transferID
    }
    public var message: String {
        switch reason {
        case .userPause: return "You paused this save during \(stage.title.lowercased())."
        case .continuedTaskEnded: return "The background task ended during \(stage.title.lowercased())."
        case .executionClaimLost: return "The app reopened without an active background task for this save."
        }
    }
}

/// A durable, redacted observation. Raw URLs, signed upload queries, response
/// bodies, and arbitrary provider error text never enter this audit record.
public struct CaptureTransferOutcome: Codable, Equatable, Sendable {
    public var operationID: UUID?
    public var receiptID: UUID?
    public var transferID: String
    public var stage: CaptureDeliveryStage
    public var observedAt: Date
    public var startedAt: Date?
    public var completedAt: Date?
    public var status: Int?
    public var errorDomain: String?
    public var errorCode: Int?
    public var providerCode: String?
    public var authorizationExpired: Bool
    public var redactedReason: String?
    public var progress: CaptureTransferProgress?
    public var responseMissing: Bool?

    public init(transferID: String, stage: CaptureDeliveryStage, result: BackgroundHTTPResult, observedAt: Date = Date()) {
        self.transferID = transferID; self.stage = stage; self.observedAt = observedAt
        completedAt = result.completedAt
        status = result.status; errorCode = result.errorCode
        let domain = result.errorDomain ?? ""
        errorDomain = domain.range(of: #"^[A-Za-z0-9_.-]{1,100}$"#, options: .regularExpression) != nil ? domain : nil
        let body = String(decoding: result.body.prefix(16_384), as: UTF8.self)
        let codes: Set<String> = ["AccessDenied", "SignatureDoesNotMatch", "InvalidAccessKeyId", "ExpiredToken", "RequestTimeTooSkewed", "RequestExpired", "RequestHasExpired", "SlowDown", "InternalError", "ServiceUnavailable", "EntityTooLarge", "EntityTooSmall", "BadDigest", "InvalidDigest", "IncompleteBody", "IncorrectEndpoint", "PermanentRedirect", "AuthorizationHeaderMalformed"]
        if let start = body.range(of: "<Code>"), let end = body.range(of: "</Code>", range: start.upperBound..<body.endIndex) {
            let candidate = String(body[start.upperBound..<end.lowerBound])
            providerCode = codes.contains(candidate) ? candidate : nil
        } else { providerCode = nil }
        authorizationExpired = result.status == 403 && (["ExpiredToken", "RequestExpired", "RequestHasExpired"].contains(providerCode ?? "") || body.contains("<Message>Request has expired</Message>"))
        if result.error != nil {
            switch result.errorCode {
            case NSURLErrorCancelled: redactedReason = "The transfer was stopped."
            case NSURLErrorTimedOut: redactedReason = "The network request timed out."
            case NSURLErrorNotConnectedToInternet: redactedReason = "The device is offline."
            case NSURLErrorNetworkConnectionLost: redactedReason = "The network connection was lost."
            case NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed: redactedReason = "The upload service could not be reached."
            case NSURLErrorFileDoesNotExist, NSURLErrorNoPermissionsToReadFile: redactedReason = "The prepared upload file could not be read."
            default: redactedReason = "The network transfer did not finish."
            }
        } else if let status = result.status, !(200..<300).contains(status) {
            redactedReason = "The service returned HTTP \(status)" + (providerCode.map { " (\($0))" } ?? "") + "."
        } else { redactedReason = nil }
    }
}
