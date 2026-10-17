import XCTest
@testable import CaptureCore

final class CaptureForegroundAdmissionTests: XCTestCase {
    func testOrdinaryForegroundWorkUsesTheCurrentTicket() throws {
        let admission = CaptureForegroundAdmission()
        let ticket = try XCTUnwrap(admission.ticket)
        XCTAssertTrue(admission.allows(ticket))
        XCTAssertEqual(admission.ticket, ticket)
    }

    func testReportEntryInvalidatesWorkQueuedBeforeTheReport() throws {
        var admission = CaptureForegroundAdmission()
        let queued = try XCTUnwrap(admission.ticket)
        admission.hold()
        XCTAssertTrue(admission.isHeld)
        XCTAssertNil(admission.ticket)
        XCTAssertFalse(admission.allows(queued))
    }

    func testRepeatedReportEntryKeepsAutomaticWorkHeld() throws {
        var admission = CaptureForegroundAdmission()
        let queued = try XCTUnwrap(admission.ticket)
        for _ in 0..<10 {
            admission.hold()
            XCTAssertNil(admission.ticket)
            XCTAssertFalse(admission.allows(queued))
        }
    }

    func testConfirmedOpenReleasesOnceWithANewTicket() throws {
        var admission = CaptureForegroundAdmission()
        let before = try XCTUnwrap(admission.ticket)
        admission.hold()
        XCTAssertTrue(admission.release())
        let resumed = try XCTUnwrap(admission.ticket)
        XCTAssertTrue(admission.allows(resumed))
        XCTAssertFalse(admission.allows(before))
        XCTAssertFalse(admission.release())
        XCTAssertEqual(admission.ticket, resumed)
    }

    func testAnotherReportInvalidatesAnExitTaskWaitingToResume() throws {
        var admission = CaptureForegroundAdmission()
        admission.hold()
        XCTAssertTrue(admission.release())
        let exitTask = try XCTUnwrap(admission.ticket)
        admission.hold()
        XCTAssertFalse(admission.allows(exitTask))
        XCTAssertTrue(admission.release())
        XCTAssertFalse(admission.allows(exitTask))
        XCTAssertTrue(admission.allows(try XCTUnwrap(admission.ticket)))
    }

    func testTicketsFromAnotherSessionAreRejected() throws {
        let first = CaptureForegroundAdmission(), second = CaptureForegroundAdmission()
        XCTAssertFalse(second.allows(try XCTUnwrap(first.ticket)))
    }

    func testWarmReportRetainsBackgroundSessionOwnership() {
        var launch = CaptureStorageLaunchGate(), foreground = CaptureForegroundAdmission()
        launch.connectScene(reportRequested: false)
        XCTAssertTrue(launch.admitNormalWork())
        foreground.hold()
        launch.requestReport()
        XCTAssertNil(foreground.ticket)
        XCTAssertTrue(launch.normalWorkAdmitted)
        XCTAssertTrue(launch.admitNormalWork(background: true))
    }

    func testColdReportRequiresExplicitCaptureBeforeSessionAdmission() {
        var launch = CaptureStorageLaunchGate()
        launch.connectScene(reportRequested: true)
        XCTAssertFalse(launch.admitNormalWork())
        XCTAssertFalse(launch.admitNormalWork(background: true))
        launch.requestCapture()
        XCTAssertTrue(launch.admitNormalWork())
    }
}
