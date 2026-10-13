#if os(iOS)
import CaptureCore
import Foundation
import SwiftUI

/// Source context for the native SoundCloud capture path.
struct SoundCloudSourceView: View {
    let plan: JSONValue

    private var source: JSONValue? { plan["sources"]?.array.first }
    private var details: JSONValue? { source?["soundcloud"] }
    private var kind: String { details?["kind"]?.string ?? "" }
    private var artwork: URL? { details?["artworkUrl"]?.string.flatMap(URL.init(string:)) }
    private var artists: String {
        if kind == "playlist" { return source?["author"]?["name"]?.string ?? source?["author"]?["handle"]?.string ?? "SoundCloud" }
        return details?["artists"]?.array.compactMap(\.string).joined(separator: ", ") ?? ""
    }
    private var duration: String? {
        guard let value = details?["durationSeconds"], case .number(let raw) = value, raw.isFinite, raw > 0 else { return nil }
        let seconds = Int(raw), minutes = seconds / 60
        return minutes >= 60 ? "\(minutes / 60):\(String(format: "%02d", minutes % 60)):\(String(format: "%02d", seconds % 60))"
            : "\(minutes):\(String(format: "%02d", seconds % 60))"
    }

    var body: some View {
        if source?["provider"]?.string == "soundcloud", kind == "track" || kind == "playlist" {
            HStack(alignment: .top, spacing: 12) {
                if let artwork {
                    AsyncImage(url: artwork) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() }
                        else { artworkPlaceholder }
                    }
                    .frame(width: 64, height: 64).clipped()
                    .accessibilityHidden(true)
                } else { artworkPlaceholder.frame(width: 64, height: 64).accessibilityHidden(true) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(kind == "playlist" ? "SoundCloud playlist" : "SoundCloud track")
                        .font(.caption).foregroundStyle(.secondary)
                    if !artists.isEmpty { Text(artists).font(.subheadline).lineLimit(2) }
                    if kind == "playlist" {
                        Text("\(details?["declaredTrackCount"]?.int ?? 0) tracks in source order")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        if let duration { Text(duration).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                        Text("Original audio stays on SoundCloud; this device saves its source link.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("capture.soundcloud.source")
        }
    }

    private var artworkPlaceholder: some View {
        Rectangle().fill(Color(uiColor: .secondarySystemBackground))
            .overlay { Image(systemName: kind == "playlist" ? "music.note.list" : "waveform").foregroundStyle(.secondary) }
    }
}
#endif
