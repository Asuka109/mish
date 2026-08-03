import SwiftUI

@main
struct MishShellPrototypeApp: App {
    @StateObject private var authority = PrototypeShellAuthority()

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

    var title: String { rawValue.capitalized }

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
        case let value where value.hasPrefix("/status/"): .home
        case "/routes": .routes
        case let value where value.hasPrefix("/routes/"): .routes
        case "/profiles": .profiles
        case let value where value.hasPrefix("/profiles/"): .profiles
        case "/traffic", "/events": .activity
        case "/settings": .settings
        case let value where value.hasPrefix("/settings/"): .settings
        default: nil
        }
    }
}

private struct PrototypeShellSnapshot: Equatable {
    var revision: UInt64 = 0
    var selectedTab: PrototypeTab = .home
    var webEntryPath: String = PrototypeTab.home.rootPath
}

/// This mock models only the Shared Rust outer-shell authority. React Router
/// remains the sole owner of WebView routes, history, back, and DOM focus.
/// There is intentionally no Web-originated native command API.
@MainActor
private final class PrototypeShellAuthority: ObservableObject {
    @Published private(set) var snapshot = PrototypeShellSnapshot()
    private var retiredIntentIDs = Set<String>()

    func select(tab: PrototypeTab, expectedRevision: UInt64, intentID: String) {
        guard admit(expectedRevision: expectedRevision, intentID: intentID) else { return }
        snapshot.selectedTab = tab
        snapshot.webEntryPath = tab.rootPath
        commit(intentID: intentID)
    }

    /// Platform launch/deep-link input only. Web content cannot call this API.
    func openExternal(path: String, expectedRevision: UInt64, intentID: String) {
        guard let tab = PrototypeTab.tab(for: path),
              admit(expectedRevision: expectedRevision, intentID: intentID)
        else { return }
        snapshot.selectedTab = tab
        snapshot.webEntryPath = path
        commit(intentID: intentID)
    }

    private func admit(expectedRevision: UInt64, intentID: String) -> Bool {
        expectedRevision == snapshot.revision && !retiredIntentIDs.contains(intentID)
    }

    private func commit(intentID: String) {
        snapshot.revision += 1
        retiredIntentIDs.insert(intentID)
        if retiredIntentIDs.count > 128 {
            retiredIntentIDs.removeAll(keepingCapacity: true)
            retiredIntentIDs.insert(intentID)
        }
    }
}

private struct PrototypeTabShell: View {
    @ObservedObject var authority: PrototypeShellAuthority
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
                    PrototypeOuterNavigation(tab: tab, snapshot: authority.snapshot)
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

private struct PrototypeOuterNavigation: View {
    let tab: PrototypeTab
    let snapshot: PrototypeShellSnapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showsShellDiagnostics = false

    var body: some View {
        NavigationStack {
            PrototypeWebViewBoundary(snapshot: snapshot)
                .navigationTitle(tab.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Shell information", systemImage: "info.circle") {
                            showsShellDiagnostics = true
                        }
                        .keyboardShortcut("i", modifiers: [.command, .shift])
                        .hoverEffect(.highlight)
                    }
                }
        }
        .sheet(isPresented: $showsShellDiagnostics) {
            NavigationStack {
                List {
                    LabeledContent("Shell revision", value: String(snapshot.revision))
                    LabeledContent("One-way Web entry", value: snapshot.webEntryPath)
                    Label("No Web-to-Native command bridge", systemImage: "arrow.right")
                    Label(
                        reduceMotion ? "Reduce Motion" : "System motion",
                        systemImage: "figure.walk.motion"
                    )
                    Label(
                        reduceTransparency ? "Opaque fallback" : "System material",
                        systemImage: "circle.lefthalf.filled"
                    )
                    Label(
                        "Dynamic Type: \(String(describing: dynamicTypeSize))",
                        systemImage: "textformat.size"
                    )
                }
                .navigationTitle("Native shell")
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
    }
}

/// The SwiftUI package deliberately does not instantiate product content or
/// five WebViews. A future UIKit host adapter must place exactly one Tauri-owned
/// WKWebView here and deliver `webEntryPath` toward React Router. The WebView
/// must expose no script message handler or other route backchannel to Native.
private struct PrototypeWebViewBoundary: View {
    let snapshot: PrototypeShellSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Single host-owned WKWebView", systemImage: "safari")
                .font(.title2.bold())
            Text("One-way entry: \(snapshot.webEntryPath)")
                .font(.body.monospaced())
            Text("React Router owns all content, internal history, back, and DOM focus inside this boundary.")
                .font(.body)
            Text("This placeholder is shell evidence only; it is not a native product screen.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding()
        .background(.background)
        .accessibilityElement(children: .contain)
    }
}
