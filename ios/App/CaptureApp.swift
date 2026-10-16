import AppIntents
import CaptureCore
import BackgroundTasks
import CaptureUI
import SwiftUI
import UIKit
import OSLog

private enum CaptureAppLaunchPolicy {
    static var storageAuditOnly: Bool {
        #if CAPTURE_STORAGE_AUDIT_BUILD
        let forcedAuditBuild = true
        #else
        let forcedAuditBuild = false
        #endif
        return CaptureLaunchPolicy.storageAuditOnly(environment: ProcessInfo.processInfo.environment,
                                                   forcedAuditBuild: forcedAuditBuild)
    }
}

@main
@MainActor
struct CaptureApp: App {
    @UIApplicationDelegateAdaptor(CaptureApplicationDelegate.self) private var applicationDelegate
    private let session: CaptureSession?
    private let startupError: String?
    private static var storageAuditOnly: Bool { CaptureAppLaunchPolicy.storageAuditOnly }
    init() {
        if Self.storageAuditOnly { session = nil; startupError = nil; return }
        do { let created = try CaptureApplicationDelegate.makeSession(); session = created; startupError = nil }
        catch { session = nil; startupError = error.localizedDescription }
    }
    var body: some Scene {
        WindowGroup {
            if Self.storageAuditOnly { CaptureStorageAuditView() }
            else if let session { CaptureRootView(session: session) }
            else { ContentUnavailableView("Capture could not open", systemImage: "exclamationmark.triangle", description: Text(startupError ?? "Try opening the app again.")) }
        }
    }
}

@MainActor
final class CaptureApplicationDelegate: NSObject, UIApplicationDelegate {
    private static var storageAuditOnly: Bool { CaptureAppLaunchPolicy.storageAuditOnly }
    static var session: CaptureSession?
    private static var submissionTask = UIBackgroundTaskIdentifier.invalid
    private static var recoveryEarliestBeginDate: Date?
    @available(iOS 26.0, *) private static var continuedCoordinator: CaptureContinuedCoordinator?
    static var recoveryIdentifier: String { (Bundle.main.bundleIdentifier ?? "capture") + ".delivery-recovery" }

    private static func beginSubmission() {
        guard submissionTask == .invalid else { return }
        submissionTask = UIApplication.shared.beginBackgroundTask(withName: "Finish capture save") {
            Task { @MainActor in endSubmission() }
        }
    }

    private static func endSubmission() {
        guard submissionTask != .invalid else { return }
        let identifier = submissionTask
        submissionTask = .invalid
        UIApplication.shared.endBackgroundTask(identifier)
    }

    static func makeSession() throws -> CaptureSession {
        guard !storageAuditOnly else { throw CaptureError.message("Read-only storage inspection is active.") }
        if let session { return session }
        let created = try CaptureSession()
        created.scheduleRecovery = { scheduleRecovery() }
        created.beginSubmission = { beginSubmission() }
        if #available(iOS 26.0, *) {
            let coordinator = CaptureContinuedCoordinator(session: created)
            continuedCoordinator = coordinator
            created.startContinuedProcessing = { [weak coordinator] id in coordinator?.start(id) }
            created.cancelContinuedProcessing = { [weak coordinator] id in coordinator?.cancel(id) }
            created.deliveryDidChange = { [weak coordinator] in coordinator?.refresh() }
        }
        session = created
        return created
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !Self.storageAuditOnly else { return true }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.recoveryIdentifier, using: nil) { task in
            let work = Task { @MainActor in
                Self.recoveryEarliestBeginDate = nil
                do {
                    let session = try Self.makeSession()
                    await session.resumeDelivery()
                    Self.scheduleRecovery()
                    session.releaseStoreForSuspension()
                    task.setTaskCompleted(success: !Task.isCancelled)
                } catch { task.setTaskCompleted(success: false) }
            }
            task.expirationHandler = { work.cancel() }
        }
        if #available(iOS 26.0, *) { Self.continuedCoordinator?.registerPersisted() }
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // A relaunched process has no proof that an unclaimed continued task
        // still owns execution. Persist the fence without assuming why it ended.
        try? Self.session?.prepareForegroundDelivery()
    }

    static func scheduleRecovery() {
        guard session?.hasPendingDeliveries == true else {
            recoveryEarliestBeginDate = nil
            endSubmission()
            return
        }
        if UIApplication.shared.applicationState == .background { beginSubmission() }
        let request = BGProcessingTaskRequest(identifier: recoveryIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        // Replacing a pending request on every stage must not keep moving its
        // earliest eligible time into the future.
        let earliest = recoveryEarliestBeginDate ?? Date().addingTimeInterval(60)
        request.earliestBeginDate = earliest
        recoveryEarliestBeginDate = earliest
        try? BGTaskScheduler.shared.submit(request)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        if Self.session?.hasPendingDeliveries == true { Self.beginSubmission() }
        Self.scheduleRecovery()
        Self.session?.releaseStoreForSuspension()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        Self.endSubmission()
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard let session = try? Self.makeSession() else { completionHandler(); return }
        if session.hasPendingDeliveries { Self.beginSubmission() }
        session.handleBackgroundEvents(identifier: identifier) {
            Task { @MainActor in
                Self.scheduleRecovery()
                session.releaseStoreForSuspension()
                completionHandler()
            }
        }
    }
}

/// Internal diagnostic launch path. It deliberately bypasses CaptureSession and
/// background recovery so inspecting storage cannot resume queued saves.
private struct CaptureStorageAuditView: View {
    @State private var status = "Reading storage"
    private static func sharedContainer(main: URL) -> URL? {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["CAPTURE_STORAGE_AUDIT_FIXTURE"] == "1" {
            if let value = ProcessInfo.processInfo.environment["CAPTURE_STORAGE_AUDIT_FIXTURE_ID"], let id = UUID(uuidString: value) {
                return main.appendingPathComponent("storage-audit-fixtures").appendingPathComponent(id.uuidString, isDirectory: true)
            }
            return main.appendingPathComponent("storage-audit-fixture", isDirectory: true)
        }
        #endif
        guard let group = Bundle.main.object(forInfoDictionaryKey: "CaptureAppGroup") as? String else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }
    var body: some View {
        ScrollView { Text(status).font(.body.monospaced()).padding().textSelection(.enabled) }
            .task {
                let main = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
                guard let shared = Self.sharedContainer(main: main) else {
                    status = "The shared container is unavailable."; return
                }
                let reports = await Task.detached {
                    ["main": CaptureStorageAudit.inspect(container: main),
                     "shared": CaptureStorageAudit.inspect(container: shared, database: shared.appendingPathComponent("capture.sqlite"))]
                }.value
                do {
                    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
                    let directory = main.appendingPathComponent("Documents/CaptureStorageAudit")
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let file = directory.appendingPathComponent(UUID().uuidString + ".json")
                    try encoder.encode(reports).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    status = reports.keys.sorted().map { key in
                        let report = reports[key]!
                        return "\(key): \(report.logicalBytes) logical bytes\n" + report.categoryBytes.keys.sorted().map { "\($0): \(report.categoryBytes[$0]!)" }.joined(separator: "\n") + "\nProblems: \(report.problems.count)"
                    }.joined(separator: "\n\n") + "\n\nNo cleanup or saves performed.\nReport: " + file.lastPathComponent
                } catch { status = "The read-only report could not be exported: " + error.localizedDescription }
            }
    }
}

/// Request iOS 26 execution for a retained save and update its system progress display.
/// Read confirmed remote completion from the save journal.
@available(iOS 26.0, *)
@MainActor
private final class CaptureContinuedCoordinator {
    private weak var session: CaptureSession?
    private var registered: Set<String> = []
    private var submitted: [UUID: UUID] = [:]
    private var runningReceipts: [UUID: UUID] = [:]
    private var running: [UUID: BGContinuedProcessingTask] = [:]
    private var displayed: [UUID: CaptureContinuedProgress] = [:]
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Capture", category: "continued-save")

    init(session: CaptureSession) { self.session = session }

    private func identifier(_ id: UUID, receipt: UUID) -> String {
        (Bundle.main.bundleIdentifier ?? "capture") + ".save." + id.uuidString + (receipt == id ? "" : "." + receipt.uuidString)
    }

    func registerPersisted() {
        for id in session?.continuedOperationIDs ?? [] {
            if let receipt = session?.continuedSaveReceiptID(id), register(id, receipt: receipt) { submitted[id] = receipt }
        }
    }

    private func register(_ id: UUID, receipt: UUID) -> Bool {
        let name = identifier(id, receipt: receipt)
        guard !registered.contains(name) else { return true }
        let accepted = BGTaskScheduler.shared.register(forTaskWithIdentifier: name, using: .main) { [weak self] raw in
            MainActor.assumeIsolated {
                guard let continued = raw as? BGContinuedProcessingTask else { raw.setTaskCompleted(success: false); return }
                self?.handle(continued, id: id, receipt: receipt)
            }
        }
        if accepted { registered.insert(name) }
        return accepted
    }

    func start(_ id: UUID) {
        guard UIApplication.shared.applicationState == .active, let session,
              let receipt = session.continuedSaveReceiptID(id) else { return }
        // Reusing a capture for placement edits must not submit or clear its
        // existing continued task. Receipt identities fence later cycles.
        guard submitted[id] != receipt, runningReceipts[id] != receipt else { return }
        if let previous = submitted[id] { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier(id, receipt: previous)) }
        if let task = running[id] { finish(task, id: id, success: false, releaseClaim: false) }
        guard register(id, receipt: receipt) else { return }
        do {
            guard try session.beginContinuedSave(id, receiptID: receipt) else { return }
            let fact = session.continuedProgress(id)
            let request = BGContinuedProcessingTaskRequest(identifier: identifier(id, receipt: receipt),
                title: fact?.title ?? "Saving to Are.na", subtitle: fact?.subtitle ?? "Checking save")
            request.strategy = .queue
            try BGTaskScheduler.shared.submit(request)
            submitted[id] = receipt
        } catch {
            try? session.endContinuedSave(id, receiptID: receipt)
            log.error("Continued save could not start: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func handle(_ task: BGContinuedProcessingTask, id: UUID, receipt: UUID) {
        guard let session else {
            task.setTaskCompleted(success: false)
            return
        }
        if let fact = session.continuedProgress(id), fact.receiptID == receipt, fact.isTerminal {
            task.progress.totalUnitCount = fact.activityTotalUnits
            task.progress.completedUnitCount = fact.activityCompletedUnits
            task.updateTitle(fact.title, subtitle: fact.subtitle)
            submitted.removeValue(forKey: id)
            task.setTaskCompleted(success: fact.isDone)
            return
        }
        guard session.continuedSaveReceiptID(id) == receipt else { task.setTaskCompleted(success: false); return }
        running[id] = task; runningReceipts[id] = receipt
        submitted[id] = receipt
        task.expirationHandler = { [weak self, weak task] in
            let persistPause = {
                MainActor.assumeIsolated {
                    guard let task else { return }
                    self?.expire(task, id: id)
                }
            }
            // Expiration grants little cleanup time. Persist the mutation
            // fence before returning from the callback, on the main actor.
            if Thread.isMainThread { persistPause() }
            else { DispatchQueue.main.sync(execute: persistPause) }
        }
        session.activateContinuedSave(id, receiptID: receipt)
        refresh(id)
        Task { await session.resumeDelivery() }
    }

    func refresh() {
        for id in Array(running.keys) { refresh(id) }
        for (id, receipt) in Array(submitted) where running[id] == nil {
            let fact = session?.continuedProgress(id)
            if fact == nil || fact?.receiptID != receipt || fact?.isTerminal == true {
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier(id, receipt: receipt))
                submitted.removeValue(forKey: id)
                try? session?.endContinuedSave(id, receiptID: receipt)
            }
        }
    }

    private func refresh(_ id: UUID) {
        guard let task = running[id], let receipt = runningReceipts[id] else { return }
        guard let fact = session?.continuedProgress(id) else { finish(task, id: id, success: false); return }
        guard fact.receiptID == receipt else { finish(task, id: id, success: false, releaseClaim: false); return }
        if displayed[id] != fact {
            task.progress.totalUnitCount = fact.activityTotalUnits
            task.progress.completedUnitCount = fact.activityCompletedUnits
            task.updateTitle(fact.title, subtitle: fact.subtitle)
            displayed[id] = fact
        }
        if fact.isDone { finish(task, id: id, success: true) }
        else if fact.isTerminal { finish(task, id: id, success: false) }
    }

    private func expire(_ task: BGContinuedProcessingTask, id: UUID) {
        guard running[id] === task, let receipt = runningReceipts[id] else { return }
        do {
            try session?.pauseContinuedSave(id, receiptID: receipt)
            task.updateTitle("Save interrupted", subtitle: "Background task ended. Open Capture to review the retained save.")
            finish(task, id: id, success: false)
        } catch {
            // Retain the durable claim if SQLite could not record Stop. No
            // unowned continuation may issue another mutation.
            session?.deactivateContinuedSave(id, receiptID: receipt)
            log.error("Could not persist continued-save pause: \(error.localizedDescription, privacy: .public)")
            finish(task, id: id, success: false, releaseClaim: false)
        }
    }

    func cancel(_ id: UUID) {
        if let receipt = submitted[id] { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier(id, receipt: receipt)) }
        submitted.removeValue(forKey: id)
        if let task = running[id] { finish(task, id: id, success: false) }
    }

    private func finish(_ task: BGContinuedProcessingTask, id: UUID, success: Bool, releaseClaim: Bool = true) {
        guard running[id] === task else { return }
        let receipt = runningReceipts.removeValue(forKey: id)
        displayed.removeValue(forKey: id)
        running.removeValue(forKey: id)
        submitted.removeValue(forKey: id)
        task.expirationHandler = nil
        if releaseClaim { try? session?.endContinuedSave(id, receiptID: receipt) }
        task.setTaskCompleted(success: success)
    }
}

// Uses the same local transaction as Save/Connect. The result confirms acceptance, not remote completion.
enum ShortcutCaptureMedia: String, AppEnum {
    case automatic, all, none
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Media"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .automatic: "Automatic", .all: "All", .none: "None"
    ]
    var policy: MediaPolicy { switch self { case .automatic: .auto; case .all: .all; case .none: .none } }
}

struct SubmitCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Link to Are.na"
    static var description = IntentDescription("Save a link to Are.na. Check its progress in Capture's History tab.")
    static var openAppWhenRun = false
    @Parameter(title: "URL") var url: URL
    @Parameter(title: "Title") var captureTitle: String?
    @Parameter(title: "Description") var captureDescription: String?
    @Parameter(title: "Media", default: .automatic) var media: ShortcutCaptureMedia
    @Parameter(title: "Channel IDs") var channelIDs: [Int]?

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let session = try CaptureApplicationDelegate.makeSession()
        let id = try session.submitLink(url, title: captureTitle, description: captureDescription, media: media.policy, channelIDs: channelIDs ?? [])
        return .result(value: id.uuidString, dialog: "Capture queued. Open History to check progress.")
    }
}
