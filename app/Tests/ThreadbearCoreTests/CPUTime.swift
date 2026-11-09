import Darwin
import XCTest

/// The CPU time this thread spends in `work`. "It's quick" tests measure this
/// rather than the clock: on a check host running other threads' builds, the
/// clock counts the time spent waiting for a core too, and
/// testHasScriptsIsQuickOnPathologicalPages failed on 6.7 seconds with nothing
/// wrong (7 Nov).
func cpuSeconds(_ work: () -> Void) -> TimeInterval {
    let started = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
    work()
    return TimeInterval(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - started) / 1_000_000_000
}

final class CPUTimeTests: XCTestCase {
    func testWaitingDoesntCountAndWorkDoes() {
        XCTAssertLessThan(cpuSeconds { Thread.sleep(forTimeInterval: 0.5) }, 0.25, "waiting isn't working")
        XCTAssertGreaterThan(cpuSeconds {
            let until = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) + 100_000_000
            while clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) < until {}
        }, 0.09)
    }
}
