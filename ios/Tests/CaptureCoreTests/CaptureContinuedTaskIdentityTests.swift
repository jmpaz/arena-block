import XCTest
@testable import CaptureCore

final class CaptureContinuedTaskIdentityTests: XCTestCase {
    func testLegacyRequestUsesOperationAsReceiptAndLaterPlacementKeepsItsOwnReceipt() throws {
        let operation = UUID(), receipt = UUID(), prefix = "org.arenacapture.app.save."
        let legacy = try XCTUnwrap(CaptureContinuedTaskIdentity(identifier: prefix + operation.uuidString, bundleIdentifier: "org.arenacapture.app"))
        let later = try XCTUnwrap(CaptureContinuedTaskIdentity(identifier: prefix + operation.uuidString + "." + receipt.uuidString, bundleIdentifier: "org.arenacapture.app"))
        XCTAssertEqual(legacy.operationID, operation); XCTAssertEqual(legacy.receiptID, operation)
        XCTAssertEqual(later.operationID, operation); XCTAssertEqual(later.receiptID, receipt)
        XCTAssertNotEqual(legacy, later, "A later placement cannot resume the original receipt")
    }

    func testForeignMalformedAndUnrelatedPendingRequestsCannotRegisterSaveHandlers() {
        let id = UUID().uuidString, prefix = "org.arenacapture.app.save."
        for value in ["other.app.save." + id, "org.arenacapture.app.delivery-recovery", prefix + "*", prefix + id + ".", prefix + "." + id, prefix + id + ".invalid", prefix + id + "." + id + "." + id] {
            XCTAssertNil(CaptureContinuedTaskIdentity(identifier: value, bundleIdentifier: "org.arenacapture.app"), value)
        }
    }
}
