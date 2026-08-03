import SwiftUI

@main
struct MishShellPrototypeApp: App {
    @StateObject private var authority = PrototypeNavigationAuthority()

    var body: some Scene {
        WindowGroup {
            PrototypeTabShell(authority: authority)
        }
    }
}

private enum PrototypeTab: String, CaseIterable, Hashable {
    case home
    case routes
    case profiles
    case activity
    case settings

    var title: String {
        rawValue.capitalized
    }

    var systemImage: String {
        switch self {
        case .home: "house"
        case .routes: "circle.grid.2x2"
        case .profiles: "doc.text"
        case .activity: "waveform.path.ecg"
        case .settings: "gearshape"
        }
    }

    var rootPath: String {
        switch self {
        case .home: "/status"
        case .routes: "/routes"
        case .profiles: "/profiles"
        case .activity: "/traffic"
        case .settings: "/settings"
        }
    }

    static func tab(for path: String) -> Self? {
        let pathOnly = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        switch pathOnly {
        case "/status": .home
        case "/routes": .routes
        case let value where value.hasPrefix("/routes/"): .routes
        case "/profiles": .profiles
        case "/traffic", "/events": .activity
        case "/settings": .settings
        case let value where value.hasPrefix("/settings/"): .settings
        default: nil
        }
    }
}

private struct PrototypeNavigationSnapshot: Equatable {
    var revision: UInt64 = 0
    var focusToken: UInt64 = 0
    var selectedTab: PrototypeTab = .home
    var stacks: [PrototypeTab: [String]] = Dictionary(
        uniqueKeysWithValues: PrototypeTab.allCases.map { ($0, [$0.rootPath]) }
    )

    var activePath: String {
        stacks[selectedTab]?.last ?? selectedTab.rootPath
    }
}

/// This native mock has exactly the API the accepted implementation would
/// delegate to the research-only Shared Rust authority over Tauri FFI.
@MainActor
private final class PrototypeNavigationAuthority: ObservableObject {
    @Published private(set) var snapshot = PrototypeNavigationSnapshot()
    private var retiredIntentIDs = Set<String>()

    func select(tab: PrototypeTab, expectedRevision: UInt64, intentID: String) {
        guard admit(expectedRevision: expectedRevision, intentID: intentID) else { return }
        snapshot.selectedTab = tab
        commit(intentID: intentID)
    }

    func open(path: String, expectedRevision: UInt64, intentID: String) {
        guard let tab = PrototypeTab.tab(for: path),
              admit(expectedRevision: expectedRevision, intentID: intentID)
        else { return }
        snapshot.selectedTab = tab
        var stack = snapshot.stacks[tab] ?? [tab.rootPath]
        if path == tab.rootPath {
            stack = [tab.rootPath]
        } else if stack.last != path {
            stack.append(path)
        }
        snapshot.stacks[tab] = stack
        commit(intentID: intentID)
    }

    func replaceProjectedPath(
        for tab: PrototypeTab,
        with path: [String],
        expectedRevision: UInt64,
        intentID: String
    ) {
        guard admit(expectedRevision: expectedRevision, intentID: intentID) else { return }
        snapshot.selectedTab = tab
        snapshot.stacks[tab] = [tab.rootPath] + path
        commit(intentID: intentID)
    }

    private func admit(expectedRevision: UInt64, intentID: String) -> Bool {
        expectedRevision == snapshot.revision && !retiredIntentIDs.contains(intentID)
    }

    private func commit(intentID: String) {
        snapshot.revision += 1
        snapshot.focusToken += 1
        retiredIntentIDs.insert(intentID)
        if retiredIntentIDs.count > 128 {
            retiredIntentIDs.removeAll(keepingCapacity: true)
            retiredIntentIDs.insert(intentID)
        }
    }
}

private struct PrototypeTabShell: View {
    @ObservedObject var authority: PrototypeNavigationAuthority
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        TabView(selection: Binding(
            get: { authority.snapshot.selectedTab },
            set: { tab in
                authority.select(
                    tab: tab,
                    expectedRevision: authority.snapshot.revision,
                    intentID: "apple-tab-\(UUID().uuidString)"
                )
            }
        )) {
            ForEach(PrototypeTab.allCases, id: \.self) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    PrototypeNavigationStack(tab: tab, authority: authority)
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .tabBarMinimizeBehavior(.onScrollDown)
        .overlay(alignment: .topTrailing) {
            if horizontalSizeClass == .regular {
                Text("Regular width · adaptable sidebar")
                    .font(.caption)
                    .padding(8)
                    .background(.regularMaterial, in: .capsule)
                    .padding()
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct PrototypeNavigationStack: View {
    let tab: PrototypeTab
    @ObservedObject var authority: PrototypeNavigationAuthority

    private var projectedPath: Binding<[String]> {
        Binding(
            get: { Array((authority.snapshot.stacks[tab] ?? [tab.rootPath]).dropFirst()) },
            set: { path in
                authority.replaceProjectedPath(
                    for: tab,
                    with: path,
                    expectedRevision: authority.snapshot.revision,
                    intentID: "apple-stack-\(UUID().uuidString)"
                )
            }
        )
    }

    var body: some View {
        NavigationStack(path: projectedPath) {
            PrototypeRouteProjection(tab: tab, authority: authority)
                .navigationDestination(for: String.self) { _ in
                    PrototypeRouteProjection(tab: tab, authority: authority)
                }
        }
    }
}

private struct PrototypeRouteProjection: View {
    let tab: PrototypeTab
    @ObservedObject var authority: PrototypeNavigationAuthority
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var headingFocused: Bool
    @State private var showsSheet = false

    private var snapshot: PrototypeNavigationSnapshot { authority.snapshot }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(snapshot.activePath)
                    .font(.largeTitle.bold())
                    .accessibilityFocused($headingFocused)

                Text("React Router projection of Shared Rust navigation revision \(snapshot.revision).")
                    .font(.body)

                ViewThatFits(in: .horizontal) {
                    HStack { environmentFacts }
                    VStack(alignment: .leading) { environmentFacts }
                }

                Button("Open a child route") {
                    authority.open(
                        path: childPath,
                        expectedRevision: snapshot.revision,
                        intentID: "swift-link-\(UUID().uuidString)"
                    )
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("o", modifiers: .command)
                .hoverEffect(.highlight)
                .accessibilityHint("Adds one route to the selected tab's authoritative stack")

                Button("Open system sheet") {
                    showsSheet = true
                }
                .buttonStyle(.bordered)
                .keyboardShortcut("s", modifiers: [.command, .shift])
                .hoverEffect(.highlight)

                ForEach(0..<18, id: \.self) { index in
                    LabeledContent("Evidence row \(index + 1)", value: snapshot.activePath)
                        .padding(.vertical, 8)
                    Divider()
                }
            }
            .padding()
        }
        .navigationTitle(tab.title)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Sheet", systemImage: "slider.horizontal.3") {
                    showsSheet = true
                }
            }
        }
        .sheet(isPresented: $showsSheet, onDismiss: restoreRouteFocus) {
            NavigationStack {
                List {
                    Label("System detents", systemImage: "rectangle.bottomhalf.inset.filled")
                    Label("Pointer and keyboard", systemImage: "keyboard")
                    Label("VoiceOver order", systemImage: "accessibility")
                    Label("Disabled state", systemImage: "nosign")
                        .disabled(true)
                }
                .navigationTitle("Native sheet")
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onAppear(perform: restoreRouteFocus)
        .onChange(of: snapshot.focusToken) { _, _ in restoreRouteFocus() }
    }

    @ViewBuilder
    private var environmentFacts: some View {
        Label(reduceMotion ? "Reduce Motion" : "System motion", systemImage: "figure.walk.motion")
        Label(
            reduceTransparency ? "Opaque fallback" : "System Liquid Glass",
            systemImage: "circle.lefthalf.filled"
        )
        Label("Dynamic Type: \(String(describing: dynamicTypeSize))", systemImage: "textformat.size")
    }

    private var childPath: String {
        switch tab {
        case .home: "/status/session"
        case .routes: "/routes/streaming"
        case .profiles: "/profiles/import"
        case .activity: "/events"
        case .settings: "/settings/network"
        }
    }

    private func restoreRouteFocus() {
        DispatchQueue.main.async {
            headingFocused = true
        }
    }
}
