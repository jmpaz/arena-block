import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import AVFoundation
@testable import CaptureCore

final class NativeMediaTests: XCTestCase {
    func testVideoCompositionLoopsStillTracksToRecipeDuration() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = try fixture(color: CGColor(red: 0, green: 1, blue: 0, alpha: 1), directory: directory)
        let media = try await NativeMediaRenderer.inspect(ref: "0.0", kind: "image", file: file)
        let recipe = NativeMediaRecipe(kind: "video", width: 64, height: 64, tiles: [.init(ref: "0.0", rect: CGRect(x: 0, y: 0, width: 64, height: 64))], duration: 2.5, fps: 24, maximumBytes: 1024 * 1024)
        let result = try await NativeMediaRenderer.render(recipe: recipe, media: [media], directory: directory)
        let inspected = try await NativeMediaRenderer.inspect(ref: "output", kind: "video", file: result.fileURL)
        XCTAssertEqual(inspected.duration, 2.5, accuracy: 0.05)
        XCTAssertEqual(inspected.width, 64)
        XCTAssertEqual(inspected.height, 64)
        XCTAssertFalse(inspected.hasAudio)
        let image = try AVAssetImageGenerator(asset: AVURLAsset(url: result.fileURL)).copyCGImage(at: CMTime(seconds: 2, preferredTimescale: 600), actualTime: nil)
        XCTAssertEqual(image.width, 64)
        let pixels = try XCTUnwrap(CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 256, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        pixels.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
        let center = try XCTUnwrap(pixels.data).assumingMemoryBound(to: UInt8.self).advanced(by: (32 * 64 + 32) * 4)
        XCTAssertGreaterThan(center[1], 200)
        XCTAssertLessThan(center[0], 40)
        XCTAssertLessThan(center[2], 40)
    }
    func testImageRecipeKeepsTopAndBottomTilesInPlace() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let red = try fixture(color: CGColor(red: 1, green: 0, blue: 0, alpha: 1), directory: directory)
        let blue = try fixture(color: CGColor(red: 0, green: 0, blue: 1, alpha: 1), directory: directory)
        let media = try await [NativeMediaRenderer.inspect(ref: "0.0", kind: "image", file: red), NativeMediaRenderer.inspect(ref: "0.1", kind: "image", file: blue)]
        let recipe = NativeMediaRecipe(kind: "link", width: 32, height: 64, tiles: [.init(ref: "0.0", rect: CGRect(x: 0, y: 0, width: 32, height: 32)), .init(ref: "0.1", rect: CGRect(x: 0, y: 32, width: 32, height: 32))], maximumBytes: 1024 * 1024)
        let output = try await NativeMediaRenderer.render(recipe: recipe, media: media, directory: directory)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(output.fileURL as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(image.width, 32)
        XCTAssertEqual(image.height, 64)
        let context = try XCTUnwrap(CGContext(data: nil, width: 32, height: 64, bitsPerComponent: 8, bytesPerRow: 128, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: 32, height: 64))
        let bytes = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
        XCTAssertGreaterThan(bytes[(8 * 32 + 16) * 4], 200)
        XCTAssertLessThan(bytes[(8 * 32 + 16) * 4 + 2], 40)
        XCTAssertGreaterThan(bytes[(56 * 32 + 16) * 4 + 2], 200)
    }

    func testOutputLimitRejectsAndRemovesArtifact() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = try fixture(color: CGColor(gray: 0.5, alpha: 1), directory: directory)
        let media = try await NativeMediaRenderer.inspect(ref: "0.0", kind: "image", file: file)
        do {
            _ = try await NativeMediaRenderer.render(recipe: .init(kind: "link", width: 32, height: 32, tiles: [.init(ref: "0.0", rect: CGRect(x: 0, y: 0, width: 32, height: 32))], maximumBytes: 1), media: [media], directory: directory)
            XCTFail("Oversized media was accepted")
        } catch {
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).map { $0.resolvingSymlinksInPath() }, [file.resolvingSymlinksInPath()])
        }
    }

    private func fixture(color: CGColor, directory: URL) throws -> URL {
        let context = try XCTUnwrap(CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(color)
        context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        let image = try XCTUnwrap(context.makeImage())
        let file = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("png")
        let output = try XCTUnwrap(CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(output, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(output))
        return file
    }
}
