import Foundation

public enum CompanionError: Error, LocalizedError, Equatable, Sendable {
    case invalidEndpoint, invalidIdentifier, invalidKey, invalidResponse, scopeMismatch
    case http(Int), network, oversizedResponse, credentialsUnavailable

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: "서버 주소는 인증 정보·경로·쿼리가 없는 HTTPS 주소여야 합니다."
        case .invalidIdentifier: "프로젝트와 작업 ID는 UUID 형식으로 입력하세요."
        case .invalidKey: "Rabbit 프로젝트 API 키 형식을 확인하세요."
        case .invalidResponse: "서버 응답을 확인할 수 없습니다. 기존 상태를 완료로 간주하지 마세요."
        case .scopeMismatch: "응답의 프로젝트 또는 작업이 요청과 일치하지 않습니다."
        case .http(let code): "상태를 가져오지 못했습니다 (HTTP \(code))."
        case .network: "서버 연결을 확인하세요."
        case .oversizedResponse: "서버 응답이 허용된 크기를 넘었습니다."
        case .credentialsUnavailable: "보안 저장소에서 프로젝트 키를 불러오지 못했습니다."
        }
    }
}

public struct RabbitEndpoint: Equatable, Sendable {
    public let origin: URL
    public let projectID: UUID
    public init(origin: String, projectID: String) throws {
        let raw = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.contains("\\"), !raw.contains("%"),
              !raw.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
              var parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw CompanionError.invalidEndpoint
        }
        parts.scheme = "https"
        parts.host = host.lowercased()
        parts.path = ""
        guard let url = parts.url else { throw CompanionError.invalidEndpoint }
        self.origin = url
        self.projectID = try Self.identifier(projectID)
    }
    public static func identifier(_ value: String) throws -> UUID {
        guard matches(value, #"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$"#),
              let id = UUID(uuidString: value) else { throw CompanionError.invalidIdentifier }
        return id
    }
    public static func validateKey(_ value: String) throws {
        guard matches(value, #"^rabbit_[A-Za-z0-9_-]{43}$"#) else { throw CompanionError.invalidKey }
    }
    public var credentialAccount: String { "\(origin.absoluteString)|\(projectID.uuidString.lowercased())" }
    public func runURL(_ runID: UUID) -> URL {
        origin.appendingPathComponent("v1").appendingPathComponent("runs").appendingPathComponent(runID.uuidString.lowercased())
    }
}

func matches(_ value: String, _ pattern: String) -> Bool {
    guard let match = value.range(of: pattern, options: .regularExpression) else { return false }
    return match == value.startIndex..<value.endIndex
}

public struct RunDetail: Decodable, Equatable, Sendable {
    public let runID: UUID
    public let projectID: UUID
    public private(set) var state: String
    public private(set) var objective: String
    public private(set) var blockReason: String?
    public let manifestReady: Bool
    public let createdAt: String
    public let runRevision: Int
    public let eventCursor: String
    public let lastEventID: UUID?
    public let maxParallelTasks: Int
    public let timeoutSeconds: Int
    public private(set) var environment: String
    enum CodingKeys: String, CodingKey {
        case runID = "run_id", projectID = "project_id", state, objective
        case blockReason = "block_reason", manifestReady = "manifest_ready", createdAt = "created_at"
        case runRevision = "run_revision", eventCursor = "event_cursor", lastEventID = "last_event_id"
        case maxParallelTasks = "max_parallel_tasks", timeoutSeconds = "timeout_seconds", environment
    }
    public static func decode(_ data: Data, endpoint: RabbitEndpoint, runID: UUID, key: String) throws -> RunDetail {
        guard data.count <= 1_048_576 else { throw CompanionError.oversizedResponse }
        var detail: RunDetail
        do { detail = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw CompanionError.invalidResponse }
        guard detail.projectID == endpoint.projectID, detail.runID == runID else { throw CompanionError.scopeMismatch }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractionalDate = formatter.date(from: detail.createdAt)
        formatter.formatOptions = [.withInternetDateTime]
        guard matches(detail.state, #"^[a-zA-Z0-9_.-]{1,80}$"#),
              matches(detail.environment, #"^[a-zA-Z0-9_.-]{1,80}$"#),
              !detail.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              detail.objective.utf16.count <= 20_000, !detail.objective.contains("\0"),
              detail.blockReason.map({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 2_000 && !$0.contains("\0") }) ?? true,
              detail.runRevision >= 1, (1...4).contains(detail.maxParallelTasks),
              (60...14_400).contains(detail.timeoutSeconds),
              fractionalDate != nil || formatter.date(from: detail.createdAt) != nil,
              validCursor(detail.eventCursor, runID: runID) else { throw CompanionError.invalidResponse }
        // Do not render an API key if a compromised server echoes it in text.
        if !key.isEmpty {
            detail.state = detail.state.replacingOccurrences(of: key, with: "[보안값 삭제]")
            detail.environment = detail.environment.replacingOccurrences(of: key, with: "[보안값 삭제]")
            detail.objective = detail.objective.replacingOccurrences(of: key, with: "[보안값 삭제]")
            detail.blockReason = detail.blockReason?.replacingOccurrences(of: key, with: "[보안값 삭제]")
        }
        return detail
    }
    private static func validCursor(_ value: String, runID: UUID) -> Bool {
        guard matches(value, #"^[A-Za-z0-9_-]{1,256}$"#) else { return false }
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let decoded = String(data: data, encoding: .utf8),
              data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value else { return false }
        let parts = decoded.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == runID.uuidString.lowercased(),
              matches(String(parts[1]), #"^(0|[1-9][0-9]*)$"#), let sequence = UInt64(parts[1]),
              sequence <= 9_007_199_254_740_991 else { return false }
        return true
    }
    public var stateLabel: String {
        switch state {
        case "queued": "접수 대기"
        case "running": "진행 중"
        case "blocked": "진행 불가"
        case "completed", "succeeded": "완료"
        case "failed": "실패"
        case "cancelled", "canceled": "취소됨"
        default: "기타 상태 (\(state))"
        }
    }
}

public enum InstructionTarget: String, CaseIterable, Identifiable, Sendable {
    case agent = "에이전트", team = "팀"
    public var id: String { rawValue }
}
public struct InstructionDraft: Equatable, Sendable {
    public var target: InstructionTarget = .agent
    public var name = ""
    public var objective = ""
    public var acceptanceCriteria = ""
    public init() {}
    public var isValid: Bool {
        [name, objective, acceptanceCriteria].allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        && name.count <= 80 && objective.count <= 20_000 && acceptanceCriteria.count <= 4_000
    }
    public var exportText: String {
        "[벤디트봇 지시 초안 · 미전송]\n대상: \(target.rawValue) / \(name)\n\n목표\n\(objective)\n\n완료 기준\n\(acceptanceCriteria)"
    }
}
