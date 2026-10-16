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

/// Explicit, local observation. Leaving this screen never re-enters normal Capture.
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

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Create a local report of storage sizes and known capture references. It won’t delete files, upload a report, or retry saves.")
                    if normalAlreadyActive {
                        Text("Capture was already running. Existing saves may continue while you create this report. The report will record that limit.")
                            .foregroundStyle(.orange)
                    } else {
                        Text("This entry has not started Capture’s save session. Transfers already owned by iOS or the share extension may still continue.")
                    }
                    Text("Unknown dependencies stay protected. This report cannot identify files that are safe to delete.")
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
                        LabeledContent("Files observed", value: String(report.files.count))
                        LabeledContent("Capture records observed", value: String(report.records.count))
                        LabeledContent("Observed metadata", value: report.stable ? "Unchanged during reading" : "Incomplete or changed")
                        Text("Background transfer and system dependencies were not queried.")
                        Button("Save report to Files") { prepareExport() }
                            .disabled(worker != nil)
                            .accessibilityIdentifier("storage-report.export")
                    }
                } footer: { Text("Collection stops at its limits. Cancellation keeps your captures and original media. Nothing is sent automatically.") }
                if owner.storageReportInterference > 0 {
                    Section {
                        if normalAlreadyActive {
                            Text("Background save activity was observed. Existing handling continues; dependency coverage is incomplete.")
                        } else {
                            Text("Background save activity needs Capture. The report is incomplete. Open Capture when you want its ordinary save handling to continue.")
                        }
                    }
                }
                Section {
                    Button("Open Capture") { openCapture = true }
                        .disabled(worker != nil)
                }
            }
            .navigationTitle("Storage report")
            .confirmationDialog("Open Capture?", isPresented: $openCapture, titleVisibility: .visible) {
                Button("Open Capture") { cancel(); owner.openCapture() }
            } message: { Text("Opening Capture can resume existing saves. Creating or canceling a report does not open it automatically.") }
            .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                          defaultFilename: "Capture-storage-report") { result in
                switch result {
                case .success: status = "Report exported. Captures and media were kept."
                case .failure: status = "The report was not exported. Captures and media were kept."
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
            status = "Background activity interrupted report entry. Open Capture explicitly to handle it."; return
        }
        guard let group = Bundle.main.object(forInfoDictionaryKey: "CaptureAppGroup") as? String,
              let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            status = "The shared storage is unavailable. Nothing was changed."; return
        }
        let main = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        let active = normalAlreadyActive, token = UUID()
        generation = token; report = nil; document = nil; status = nil
        let task = Task.detached(priority: .utility) {
            try CaptureStorageExport.collect(main: main, shared: shared, normalCaptureAlreadyActive: active)
        }
        worker = task
        Task { @MainActor in
            do {
                var value = try await task.value
                guard generation == token else { return }
                guard !task.isCancelled else { worker = nil; return }
                value.interrupted = owner.storageReportInterference > 0
                report = value
                status = value.problems.isEmpty ? "Report ready. Dependency coverage remains incomplete." : "Report ready with incomplete coverage. All data was preserved."
            } catch {
                guard generation == token else { return }
                status = "Collection stopped or reached a limit. Captures and media were kept."
            }
            if generation == token { worker = nil }
        }
    }

    private func prepareExport() {
        guard var value = report, worker == nil else { return }
        value.interrupted = value.interrupted || owner.storageReportInterference > 0
        if value.interrupted { value.stable = false }
        do { document = StorageReportDocument(try CaptureStorageExport.encoded(value)); exporting = true }
        catch { status = "The report exceeded its export limit. Captures and media were kept." }
    }

    private func cancel(interrupted: Bool = false) {
        guard worker != nil || interrupted else { return }
        worker?.cancel()
        if interrupted { report?.interrupted = true; report?.stable = false }
        status = interrupted ? "Report interrupted by background activity. Nothing was retried." : "Report canceled. Captures and media were kept."
    }
}
