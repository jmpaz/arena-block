import Foundation

/// Invalidate automatic foreground work when a storage report opens.
public struct CaptureForegroundAdmission: Sendable {
    public struct Ticket: Sendable, Equatable {
        fileprivate let generation: UUID
    }
    private var generation = UUID()
    public private(set) var isHeld = false
    public init() {}

    public var ticket: Ticket? { isHeld ? nil : Ticket(generation: generation) }
    public func allows(_ ticket: Ticket) -> Bool { !isHeld && ticket.generation == generation }

    public mutating func hold() {
        guard !isHeld else { return }
        generation = UUID()
        isHeld = true
    }

    /// Called after the user confirms Open Capture.
    @discardableResult public mutating func release() -> Bool {
        guard isHeld else { return false }
        generation = UUID()
        isHeld = false
        return true
    }
}
