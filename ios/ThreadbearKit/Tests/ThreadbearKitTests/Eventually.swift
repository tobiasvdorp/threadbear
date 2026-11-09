import Foundation

/// Waits until `check` holds, looking every 20ms, for at most `timeout`.
/// A fixed sleep before an expectation fails when the whole suite runs at
/// background priority on a slower Mac (`tb land` runs it that way), as the
/// fake's timers then fire late.
func eventually(timeout: Duration = .seconds(5), _ check: () async throws -> Bool) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while clock.now < deadline {
        if try await check() { return }
        try await Task.sleep(for: .milliseconds(20))
    }
}
