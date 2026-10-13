#if os(iOS)
import CaptureCore
import SwiftUI
import UIKit

struct PickerBlockPreview: View {
    @Bindable var session: CaptureSession
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var imageURL: URL? {
        if let rendered = session.renderURL, !session.renderIsVideo { return rendered }
        if let path = session.preview?.previewPath { return URL(fileURLWithPath: path) }
        guard let media = session.preview?.media.first(where: { session.includedMediaRefs.contains($0["ref"]?.string ?? "") }),
              let raw = media["posterUrl"]?.string ?? (media["kind"]?.string == "image" ? media["url"]?.string : nil) else { return nil }
        return URL(string: raw)
    }

    private var source: String {
        if let handle = session.preview?.plan?["sources"]?.array.first?["author"]?["handle"]?.string {
            return handle.hasPrefix("@") ? handle : "@" + handle
        }
        return URL(string: session.preview?.url ?? session.draft?.input ?? "")?.host ?? "New capture"
    }

    private var excerpt: String {
        let text = session.editorDescription
            .replacingOccurrences(of: #"(?m)^\s*>\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[`*_]"#, with: "", options: .regularExpression)
        return text.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if !dynamicTypeSize.isAccessibilitySize {
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if let imageURL, imageURL.isFileURL, let image = UIImage(contentsOfFile: imageURL.path) {
                            Image(uiImage: image).resizable().scaledToFill()
                        } else if let imageURL {
                            AsyncImage(url: imageURL) { image in image.resizable().scaledToFill() } placeholder: {
                                Image(systemName: "photo").foregroundStyle(.secondary)
                            }
                        } else {
                            Image(systemName: session.preview?.kind == "social" ? "text.alignleft" : "link")
                                .font(.title3).foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 56, height: 56)
                    .background(Color(uiColor: .tertiarySystemFill))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    let count = session.preview?.plan?["sources"]?.array.count ?? 1
                    if count > 1 {
                        Text("\(count)").font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(.background, in: Capsule()).padding(3)
                    }
                }.accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(session.editorTitle.isEmpty ? "New capture" : session.editorTitle)
                    .font(.subheadline.weight(.semibold)).lineLimit(1)
                if !dynamicTypeSize.isAccessibilitySize, !excerpt.isEmpty {
                    Text(excerpt).font(.footnote).foregroundStyle(Color.primary.opacity(0.7)).lineLimit(2)
                }
                if !dynamicTypeSize.isAccessibilitySize {
                    Text(source).font(.caption).foregroundStyle(Color.primary.opacity(0.7)).lineLimit(1)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Block preview, " + session.editorTitle)
        .accessibilityValue(source)
        .accessibilityIdentifier("channel.block-preview")
    }
}
#endif
