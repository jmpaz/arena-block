import AppKit
import Foundation

@main struct RedditPublicBrowserCLI {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 3 else {
            FileHandle.standardError.write(Data("Usage: arena-block-public-browser <Reddit URL> <reader.js>\n".utf8)); exit(2)
        }
        NSApplication.shared.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do {
                let script = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
                let reader = RedditPublicPageAcquirer(readerScript: script)
                let record = try await reader.acquire(url: CommandLine.arguments[1])
                FileHandle.standardOutput.write(Data((record + "\n").utf8)); exit(0)
            } catch { FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1) }
        }
        NSApplication.shared.run()
    }
}
