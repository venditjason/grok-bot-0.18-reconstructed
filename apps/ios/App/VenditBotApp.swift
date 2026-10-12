import SwiftUI

@main
struct VenditBotCompanionApp: App {
    var body: some Scene {
        WindowGroup {
            CompanionView()
                .tint(Color(red: 0.31, green: 0.32, blue: 0.90))
        }
    }
}

struct CompanionView: View {
    var body: some View {
        TabView {
            RunStatusView().tabItem { Label("작업", systemImage: "rectangle.stack") }
            InstructionView().tabItem { Label("지시 초안", systemImage: "square.and.pencil") }
            AboutView().tabItem { Label("설치 안내", systemImage: "iphone") }
        }
    }
}

struct RunStatusView: View {
    @AppStorage("rabbit.origin") private var origin = ""
    @AppStorage("rabbit.projectID") private var projectID = ""
    @AppStorage("rabbit.runID") private var runID = ""
    @State private var draftOrigin = ""
    @State private var draftProjectID = ""
    @State private var draftRunID = ""
    @State private var enteredKey = ""
    @State private var detail: RunDetail?
    @State private var lastChecked: Date?
    @State private var message: String?
    @State private var loading = false
    @State private var loadTask: Task<Void, Never>?
    @State private var showingConfiguration = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("Rabbit 작업 상태", systemImage: "bolt.horizontal.circle.fill")
                        .font(.title2.bold()).padding(.vertical, 8)
                    Text("데스크톱에서 받은 작업 ID로 현재 상태를 확인하세요.")
                        .foregroundStyle(.secondary)
                }
                if let detail {
                    Section("최근 조회") {
                        LabeledContent("상태", value: detail.stateLabel)
                        Text(detail.objective).textSelection(.enabled)
                        if let reason = detail.blockReason {
                            Label(reason, systemImage: "exclamationmark.circle").foregroundStyle(.orange)
                        }
                        LabeledContent("환경", value: detail.environment)
                        LabeledContent("변경 번호", value: String(detail.runRevision))
                        if let lastChecked { LabeledContent("확인 시각", value: lastChecked.formatted(date: .omitted, time: .standard)) }
                        Text("접수·진행 상태는 코드 실행 검증을 의미하지 않습니다.").font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ContentUnavailableView("연결 준비", systemImage: "link", description: Text("서버 주소, 프로젝트 ID, 작업 ID와 조회 가능한 프로젝트 키를 설정하세요."))
                    }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.secondary).accessibilityLabel("연결 안내: \(message)") }
                }
                Section {
                    Button {
                        loadTask = Task { await refresh() }
                    } label: { Label(loading ? "확인 중…" : "상태 새로고침", systemImage: "arrow.clockwise") }
                    .disabled(loading || origin.isEmpty || projectID.isEmpty || runID.isEmpty)
                    Button("연결 설정") {
                        draftOrigin = origin
                        draftProjectID = projectID
                        draftRunID = runID
                        message = nil
                        showingConfiguration = true
                    }.disabled(loading)
                }
            }
            .navigationTitle("벤디트봇")
            .refreshable { await refresh() }
            .sheet(isPresented: $showingConfiguration) { connectionForm }
            .onDisappear { loadTask?.cancel() }
        }
    }

    private var connectionForm: some View {
        NavigationStack {
            Form {
                Section("Rabbit 연결") {
                    TextField("https://your-rabbit.example", text: $draftOrigin)
                        .autocorrectionDisabled()
                    TextField("프로젝트 UUID", text: $draftProjectID).autocorrectionDisabled()
                    TextField("작업 UUID", text: $draftRunID).autocorrectionDisabled()
                    SecureField("프로젝트 API 키", text: $enteredKey)
                        .autocorrectionDisabled()
                    Text("키는 이 기기의 Keychain에 보관합니다. 비워 두면 해당 서버·프로젝트에 저장한 키를 사용합니다.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("설정 적용") {
                        do {
                            let endpoint = try RabbitEndpoint(origin: draftOrigin, projectID: draftProjectID)
                            let id = try RabbitEndpoint.identifier(draftRunID)
                            if !enteredKey.isEmpty { try TokenVault().save(enteredKey, endpoint: endpoint) }
                            _ = try TokenVault().read(endpoint: endpoint)
                            origin = endpoint.origin.absoluteString
                            projectID = endpoint.projectID.uuidString.lowercased()
                            runID = id.uuidString.lowercased()
                            enteredKey = ""
                            detail = nil
                            lastChecked = nil
                            message = "연결 설정을 적용했습니다. 상태 새로고침으로 서버 응답을 확인하세요."
                            showingConfiguration = false
                        } catch { message = safeMessage(error) }
                    }
                    Button("이 연결의 저장된 키 삭제", role: .destructive) {
                        do {
                            let endpoint = try RabbitEndpoint(origin: draftOrigin, projectID: draftProjectID)
                            try TokenVault().delete(endpoint: endpoint)
                            enteredKey = ""
                            detail = nil
                            lastChecked = nil
                            message = "이 연결의 키를 삭제했습니다."
                            showingConfiguration = false
                        } catch { message = safeMessage(error) }
                    }
                    if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    Text("이 초기 버전은 작업 상태만 조회합니다. 프로젝트 키를 발급받은 HTTPS 서버 주소를 입력하세요.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("연결 설정")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("닫기") { enteredKey = ""; showingConfiguration = false } } }
            .onDisappear { enteredKey = "" }
        }
    }

    @MainActor private func refresh() async {
        guard !loading else { return }
        loading = true
        message = nil
        defer { loading = false }
        do {
            let endpoint = try RabbitEndpoint(origin: origin, projectID: projectID)
            let id = try RabbitEndpoint.identifier(runID)
            let key = try TokenVault().read(endpoint: endpoint)
            let result = try await RabbitClient().getRun(endpoint: endpoint, runID: id, key: key)
            try Task.checkCancellation()
            detail = result
            lastChecked = .now
        } catch is CancellationError { }
          catch { message = safeMessage(error) }
    }
    private func safeMessage(_ error: Error) -> String {
        (error as? CompanionError)?.errorDescription ?? "요청을 완료하지 못했습니다."
    }
}

struct InstructionView: View {
    @State private var draft = InstructionDraft()
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("목표와 완료 기준을 정리해 데스크톱에서 이어서 작업하세요.").foregroundStyle(.secondary)
                }
                Section("대상") {
                    Picker("종류", selection: $draft.target) {
                        ForEach(InstructionTarget.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented)
                    TextField("에이전트 또는 팀 이름", text: $draft.name)
                }
                Section("목표") { TextEditor(text: $draft.objective).frame(minHeight: 130).accessibilityLabel("작업 목표") }
                Section("완료 기준") { TextEditor(text: $draft.acceptanceCriteria).frame(minHeight: 100).accessibilityLabel("완료 기준") }
                Section {
                    ShareLink(item: draft.exportText) { Label("초안 공유", systemImage: "square.and.arrow.up") }
                        .disabled(!draft.isValid)
                    Text("초안은 앱을 닫으면 사라집니다. 공유 전에 내용을 확인하세요. 원격 전송 기능은 준비 중입니다.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }.navigationTitle("지시 초안")
        }
    }
}

struct AboutView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("App Store 공개 없이 설치") {
                    Label("개인 기기 테스트", systemImage: "person.crop.circle")
                    Text("무료 Apple 계정을 Xcode에 연결해 설치할 수 있습니다. 프로비저닝이 7일 후 만료되면 다시 빌드하고 설치해야 합니다.")
                    Label("등록 기기에 배포", systemImage: "iphone.gen3")
                    Text("유료 Apple Developer Program의 Ad Hoc 배포는 등록된 기기에서 사용할 수 있습니다. 서명과 프로비저닝의 만료일을 관리해야 합니다.")
                    Link("Apple 공식 설치·계정 안내", destination: URL(string: "https://developer.apple.com/help/account/basics/about-your-developer-account")!)
                }
                Section("개발 상태") {
                    Text("SwiftUI 초기 프로토타입 · iOS 17 이상")
                    Text("실기기 설치와 운영 서버 연결은 아직 검증하지 않았습니다. 에이전트·팀 원격 지시는 후속 인증 연결이 필요합니다.")
                        .foregroundStyle(.secondary)
                }
            }.navigationTitle("설치 안내")
        }
    }
}
