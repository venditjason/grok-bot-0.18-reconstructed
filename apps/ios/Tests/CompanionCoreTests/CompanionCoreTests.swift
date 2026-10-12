#if STANDALONE_CONTRACT_CHECK
import Foundation
#else
import XCTest
@testable import CompanionCore
#endif

@MainActor
final class CompanionCoreTests: XCTestCase {
    private let projectID = "11111111-1111-4111-8111-111111111111"
    private let runID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private let key = "rabbit_" + String(repeating: "a", count: 43)
    private func endpoint() throws -> RabbitEndpoint { try .init(origin: "https://rabbit.example", projectID: projectID) }
    private func fixture(overrides: [String: Any] = [:]) throws -> Data {
        let cursor = Data("\(runID.uuidString.lowercased()):2".utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        let base: [String: Any] = [
            "run_id": runID.uuidString.lowercased(), "project_id": projectID, "state": "blocked",
            "objective": "로그인 경로 검증", "block_reason": "runtime_reverification_required",
            "manifest_ready": false, "created_at": "2026-10-12T01:00:00.000Z", "run_revision": 2,
            "event_cursor": cursor, "last_event_id": NSNull(), "max_parallel_tasks": 2,
            "timeout_seconds": 600, "environment": "development"
        ]
        return try JSONSerialization.data(withJSONObject: base.merging(overrides) { _, new in new })
    }
    private func decode(_ overrides: [String: Any] = [:]) throws -> RunDetail {
        try RunDetail.decode(fixture(overrides: overrides), endpoint: endpoint(), runID: runID, key: key)
    }
    func testNormalizesOriginAndScopesKeyAccount() throws {
        let endpoint = try RabbitEndpoint(origin: "https://Rabbit.Example/", projectID: projectID.uppercased())
        XCTAssertEqual(endpoint.origin.absoluteString, "https://rabbit.example")
        XCTAssertEqual(endpoint.credentialAccount, "https://rabbit.example|\(projectID)")
    }
    func testRejectsCredentialBearingOrNonHTTPSOrigins() {
        for raw in ["http://rabbit.example", "https://user:pass@rabbit.example", "https://rabbit.example?key=x", "https://rabbit.example#fragment", "https://rabbit.example/v1", "https://rabbit.example\\@evil.example", "https://rabbit.example/%2f", "https://rabbit.example:0", "https://rabbit.example:65536", "file:///tmp/run"] {
            XCTAssertThrowsError(try RabbitEndpoint(origin: raw, projectID: projectID), raw)
        }
    }
    func testRejectsMalformedIDs() {
        for raw in ["123", projectID + "/events", " " + projectID, projectID + "\n"] {
            XCTAssertThrowsError(try RabbitEndpoint.identifier(raw))
        }
    }
    func testRejectsMalformedKeysAndHeaderInjection() {
        for raw in ["", "sk-unknown", key + "\r\nAuthorization: Bearer x", "rabbit_" + String(repeating: "b", count: 42)] {
            XCTAssertThrowsError(try RabbitEndpoint.validateKey(raw))
        }
    }
    func testBuildsOnlyScopedReadRequest() throws {
        let request = try RabbitRequestBuilder.getRun(endpoint: endpoint(), runID: runID, key: key)
        XCTAssertEqual(request.url?.absoluteString, "https://rabbit.example/v1/runs/\(runID.uuidString.lowercased())")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Project-API-Key"), key)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.httpBody)
        XCTAssertFalse(request.httpShouldHandleCookies)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
    }
    func testDecodesBlockedStateWithoutClaimingSuccess() throws {
        let detail = try decode()
        XCTAssertEqual(detail.stateLabel, "진행 불가")
        XCTAssertEqual(detail.blockReason, "runtime_reverification_required")
        XCTAssertFalse(detail.manifestReady)
    }
    func testRejectsCrossProjectAndRunResponses() {
        XCTAssertThrowsError(try decode(["project_id": UUID().uuidString])) { XCTAssertEqual($0 as? CompanionError, .scopeMismatch) }
        XCTAssertThrowsError(try decode(["run_id": UUID().uuidString])) { XCTAssertEqual($0 as? CompanionError, .scopeMismatch) }
    }
    func testRejectsCursorFromAnotherRun() {
        let cursor = Data("\(UUID().uuidString.lowercased()):2".utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        XCTAssertThrowsError(try decode(["event_cursor": cursor]))
    }
    func testRejectsMalformedStateAndOutOfBoundsNumbers() {
        for overrides: [String: Any] in [["state": "completed\n"], ["run_revision": 0], ["max_parallel_tasks": 5], ["timeout_seconds": 59], ["created_at": "not a date"], ["objective": " "], ["block_reason": ""]] {
            XCTAssertThrowsError(try decode(overrides))
        }
    }
    func testPreservesUnknownStateAsUnknown() throws {
        XCTAssertEqual(try decode(["state": "awaiting_owner_review"]).stateLabel, "기타 상태 (awaiting_owner_review)")
    }
    func testRedactsExactKeyEchoes() throws {
        let detail = try decode(["objective": "echo \(key)", "block_reason": key, "state": key, "environment": key])
        XCTAssertFalse(detail.objective.contains(key))
        XCTAssertEqual(detail.blockReason, "[보안값 삭제]")
        XCTAssertFalse(detail.stateLabel.contains(key))
        XCTAssertEqual(detail.environment, "[보안값 삭제]")
    }
    func testRejectsMissingContractFields() throws {
        XCTAssertThrowsError(try RunDetail.decode(Data("{}".utf8), endpoint: endpoint(), runID: runID, key: key))
    }
    func testRejectsOversizedBody() throws {
        XCTAssertThrowsError(try RunDetail.decode(Data(repeating: 32, count: 1_048_577), endpoint: endpoint(), runID: runID, key: key)) {
            XCTAssertEqual($0 as? CompanionError, .oversizedResponse)
        }
    }
    func testRejectsRedirectAndHTMLResponses() throws {
        let url = try endpoint().runURL(runID)
        for status in [301, 302, 307, 308, 401, 403, 404, 500] {
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            XCTAssertThrowsError(try RabbitRequestBuilder.validateResponse(response, expectedURL: url))
        }
        let html = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html"])!
        XCTAssertThrowsError(try RabbitRequestBuilder.validateResponse(html, expectedURL: url))
    }
    func testRejectsUnexpectedResponseURLAndSize() throws {
        let url = try endpoint().runURL(runID)
        let other = HTTPURLResponse(url: URL(string: "https://other.example")!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        XCTAssertThrowsError(try RabbitRequestBuilder.validateResponse(other, expectedURL: url))
        let huge = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json", "Content-Length": "1048577"])!
        XCTAssertThrowsError(try RabbitRequestBuilder.validateResponse(huge, expectedURL: url))
    }
    func testAcceptsJSONResponse() throws {
        let url = try endpoint().runURL(runID)
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json; charset=utf-8"])!
        XCTAssertNoThrow(try RabbitRequestBuilder.validateResponse(response, expectedURL: url))
    }
    func testDraftRequiresTargetAndSuccessCriteria() {
        var draft = InstructionDraft()
        XCTAssertFalse(draft.isValid)
        draft.target = .team
        draft.name = "Rabbit 개발팀"
        draft.objective = "실패한 테스트를 수정한다"
        draft.acceptanceCriteria = "관련 테스트 통과"
        XCTAssertTrue(draft.isValid)
        XCTAssertTrue(draft.exportText.contains("미전송"))
        XCTAssertTrue(draft.exportText.contains("팀 / Rabbit 개발팀"))
        draft.objective = String(repeating: "a", count: 20_001)
        XCTAssertFalse(draft.isValid)
    }
}
