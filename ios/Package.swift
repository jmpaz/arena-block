// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ArenaCapture",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CaptureRuntime", targets: ["CaptureRuntime"]),
        .library(name: "CaptureCore", targets: ["CaptureCore"]),
        .library(name: "CaptureUI", targets: ["CaptureUI"])
    ],
    targets: [
        .target(name: "CaptureRuntime", resources: [.process("Resources")]),
        .target(name: "CaptureCore", dependencies: ["CaptureRuntime"], linkerSettings: [.linkedLibrary("sqlite3")]),
        .target(name: "CaptureUI", dependencies: ["CaptureCore", "CaptureRuntime"], resources: [.process("Resources")]),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore", "CaptureRuntime", "CaptureUI"])
    ]
)
