import CaptureCore
import SwiftUI
import UniformTypeIdentifiers

private struct StorageReportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(_ data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

/// Collects storage metadata for an explicit export to Files.
struct CaptureStorageReportView: View {
    @ObservedObject var owner: CaptureApplicationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var worker: Task<CaptureStorageExport.Report, Error>?
    @State private var generation = UUID()
    @State private var report: CaptureStorageExport.Report?
    @State private var document: StorageReportDocument?
    @State private var exporting = false
    @State private var status: String?
    @State private var openCapture = false

    private var normalAlreadyActive: Bool { owner.launchGate.normalWorkAdmitted }

    private func sharedContainer(main: URL) -> URL? {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] != nil,
           let name = ProcessInfo.processInfo.environment["CAPTURE_UI_STORE_ID"], let id = UUID(uuidString: name) {
            // An unsigned fixture has no App Group container. Collection may
            // create its empty synthetic root, but never initializes a store.
            let root = main.appendingPathComponent("Library/Application Support/CaptureUIFixtures")
                .appendingPathComponent(id.uuidString, isDirectory: true)
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            return root
        }
        #endif
        guard let group = Bundle.main.object(forInfoDictionaryKey: "CaptureAppGroup") as? String else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Review file sizes and saved capture references, then save the report to Files.")
                    if normalAlreadyActive {
                        Text("Automatic foreground checks are paused. Existing save processing may continue through the queue.")
                            .foregroundStyle(.orange)
                    } else {
                        Text("iOS and the Share extension may continue existing transfers.")
                    }
                    Text("The report is incomplete and cannot determine which files are safe to remove.")
                }
                Section {
                    if worker == nil {
                        Button(report == nil ? "Create report" : "Create another report") { create() }
                            .disabled(!normalAlreadyActive && owner.storageReportInterference > 0)
                            .accessibilityIdentifier("storage-report.create")
                    } else {
                        ProgressView("Reading storage")
                        Button("Cancel report", role: .cancel) { cancel() }
                            .accessibilityIdentifier("storage-report.cancel")
                    }
                    if let status { Text(status).textSelection(.enabled) }
                    if let report {
                        LabeledContent("Files", value: String(report.files.count))
                        LabeledContent("Capture records", value: String(report.records.count))
                        LabeledContent("Storage changes", value: report.stable ? "Unchanged during reading" : "Incomplete or changed")
                        Text("Background transfers are outside this report.")
                        Button("Save report to Files") { prepareExport() }
                            .disabled(worker != nil)
                            .accessibilityIdentifier("storage-report.export")
                    }
                } footer: { Text("Collection has size and time limits. Your captures and media stay in place.") }
                if owner.storageReportInterference > 0 {
                    Section {
                        if normalAlreadyActive {
                            Text("Existing saves are running. The report may change during collection.")
                        } else {
                            Text("A background save needs attention. Open Capture to continue it.")
                        }
                    }
                }
                Section {
                    Button("Open Capture") { openCapture = true }
                        .disabled(worker != nil)
                        .accessibilityIdentifier("storage-report.open")
                }
            }
            .navigationTitle("Storage report")
            .confirmationDialog("Open Capture?", isPresented: $openCapture, titleVisibility: .visible) {
                Button("Open Capture") { cancel(); owner.openCapture(resumeForeground: true) }
                    .accessibilityIdentifier("storage-report.confirm-open")
            } message: { Text("Opening Capture can resume existing saves.") }
            .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                          defaultFilename: "Capture-storage-report") { result in
                switch result {
                case .success: status = "Report saved to Files."
                case .failure: status = "Could not save the report. Try exporting it again."
                }
            }
            .onChange(of: scenePhase) { _, value in if value == .background { cancel() } }
            .onChange(of: owner.storageReportInterference) { _, _ in cancel(interrupted: true) }
            .onDisappear { cancel() }
        }
    }

    private func create() {
        guard worker == nil else { return }
        guard normalAlreadyActive || owner.storageReportInterference == 0 else {
            status = "A background save interrupted collection. Open Capture to continue the save."; return
        }
        let main = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        guard let shared = sharedContainer(main: main) else {
            status = "Could not read shared storage. Try opening Capture again."; return
        }
        let active = normalAlreadyActive, token = UUID()
        generation = token; report = nil; document = nil; status = nil
        #if DEBUG && targetEnvironment(simulator)
        let fixtureDelay = ProcessInfo.processInfo.environment["CAPTURE_UI_FIXTURE"] == nil ? 0
            : min(5_000, max(0, Int(ProcessInfo.processInfo.environment["CAPTURE_UI_STORAGE_REPORT_DELAY_MS"] ?? "0") ?? 0))
        #endif
        let task = Task.detached(priority: .utility) {
            #if DEBUG && targetEnvironment(simulator)
            if fixtureDelay > 0 { try await Task.sleep(for: .milliseconds(fixtureDelay)) }
            #endif
            return try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: active)
        }
        worker = task
        Task { @MainActor in
            do {
                var value = try await task.value
                guard generation == token else { return }
                guard !task.isCancelled else { worker = nil; return }
                value.interrupted = owner.storageReportInterference > 0
                report = value
                status = value.problems.isEmpty ? "Report ready. Background transfers are outside this report." : "Report ready with incomplete results. Review its reported limits."
            } catch {
                guard generation == token else { return }
                // cancel() already records the cancellation or interruption reason.
                if !task.isCancelled { status = "Collection stopped or reached a limit. Try creating another report." }
            }
            if generation == token { worker = nil }
        }
    }

    private func prepareExport() {
        guard var value = report, worker == nil else { return }
        value.interrupted = value.interrupted || owner.storageReportInterference > 0
        if value.interrupted { value.stable = false }
        do { document = StorageReportDocument(try CaptureStorageExport.encoded(value)); exporting = true }
        catch { status = "The report exceeds the export size limit." }
    }

    private func cancel(interrupted: Bool = false) {
        guard worker != nil || interrupted else { return }
        worker?.cancel()
        if interrupted { report?.interrupted = true; report?.stable = false }
        status = interrupted ? "A background save interrupted collection." : "Report canceled."
    }
}
