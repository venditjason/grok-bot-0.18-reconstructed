import Foundation

// Fallback runner for Apple's Command Line Tools, which omit XCTest.
// Executes the exact same assertion bodies as the XCTest suite; no network or Keychain writes.
class XCTestCase {}
@MainActor private enum Results { static var failures: [String] = [] }
@MainActor private func fail(_ description: String, file: StaticString, line: UInt) {
    Results.failures.append("\(file):\(line): \(description)")
}
@MainActor func XCTAssertEqual<T: Equatable>(_ lhs: @autoclosure () throws -> T, _ rhs: @autoclosure () throws -> T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { if try lhs() != rhs() { fail("Not equal. \(message)", file: file, line: line) } }
    catch { fail("Unexpected error: \(error)", file: file, line: line) }
}
@MainActor func XCTAssertTrue(_ value: @autoclosure () throws -> Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertEqual(try value(), true, file: file, line: line) }
@MainActor func XCTAssertFalse(_ value: @autoclosure () throws -> Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertEqual(try value(), false, file: file, line: line) }
@MainActor func XCTAssertNil<T>(_ value: @autoclosure () throws -> T?, file: StaticString = #filePath, line: UInt = #line) {
    do { if try value() != nil { fail("Expected nil", file: file, line: line) } }
    catch { fail("Unexpected error: \(error)", file: file, line: line) }
}
@MainActor func XCTAssertThrowsError<T>(_ value: @autoclosure () throws -> T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line, _ handler: ((Error) -> Void)? = nil) {
    do { _ = try value(); fail("Expected error. \(message)", file: file, line: line) }
    catch { handler?(error) }
}
@MainActor func XCTAssertNoThrow<T>(_ value: @autoclosure () throws -> T, file: StaticString = #filePath, line: UInt = #line) {
    do { _ = try value() } catch { fail("Unexpected error: \(error)", file: file, line: line) }
}
@main @MainActor struct ContractCheckRunner {
    static func main() {
        let suite = CompanionCoreTests()
        let tests: [(String, () throws -> Void)] = [
            ("testNormalizesOriginAndScopesKeyAccount", suite.testNormalizesOriginAndScopesKeyAccount),
            ("testRejectsCredentialBearingOrNonHTTPSOrigins", suite.testRejectsCredentialBearingOrNonHTTPSOrigins),
            ("testRejectsMalformedIDs", suite.testRejectsMalformedIDs),
            ("testRejectsMalformedKeysAndHeaderInjection", suite.testRejectsMalformedKeysAndHeaderInjection),
            ("testBuildsOnlyScopedReadRequest", suite.testBuildsOnlyScopedReadRequest),
            ("testDecodesBlockedStateWithoutClaimingSuccess", suite.testDecodesBlockedStateWithoutClaimingSuccess),
            ("testRejectsCrossProjectAndRunResponses", suite.testRejectsCrossProjectAndRunResponses),
            ("testRejectsCursorFromAnotherRun", suite.testRejectsCursorFromAnotherRun),
            ("testRejectsMalformedStateAndOutOfBoundsNumbers", suite.testRejectsMalformedStateAndOutOfBoundsNumbers),
            ("testPreservesUnknownStateAsUnknown", suite.testPreservesUnknownStateAsUnknown),
            ("testRedactsExactKeyEchoes", suite.testRedactsExactKeyEchoes),
            ("testRejectsMissingContractFields", suite.testRejectsMissingContractFields),
            ("testRejectsOversizedBody", suite.testRejectsOversizedBody),
            ("testRejectsRedirectAndHTMLResponses", suite.testRejectsRedirectAndHTMLResponses),
            ("testRejectsUnexpectedResponseURLAndSize", suite.testRejectsUnexpectedResponseURLAndSize),
            ("testAcceptsJSONResponse", suite.testAcceptsJSONResponse),
            ("testDraftRequiresTargetAndSuccessCriteria", suite.testDraftRequiresTargetAndSuccessCriteria)
        ]
        var passed = 0
        for (name, test) in tests {
            let before = Results.failures.count
            do { try test() } catch { Results.failures.append("\(name): \(error)") }
            if before == Results.failures.count { passed += 1; print("PASS \(name)") }
            else { print("FAIL \(name)") }
        }
        for failure in Results.failures { print(failure) }
        print("\(passed)/\(tests.count) contract checks passed; no external requests sent.")
        if !Results.failures.isEmpty { exit(1) }
    }
}
