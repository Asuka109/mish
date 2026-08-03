# iOS and iPadOS shell prototype

This research-only Swift package exercises the outer native shell only: system
`TabView`, a shell-level `NavigationStack`, adaptable sidebar presentation,
navigation and toolbar materials, a native-origin diagnostics sheet, Dynamic
Type, Reduce Motion, Reduce Transparency, pointer hover, keyboard shortcuts,
and compact or regular layouts. It contains no Mish product runtime and is not
linked into the Tauri application.

The content area is deliberately a boundary placeholder, not a native product
screen. A production host candidate must place exactly one Tauri-owned
`WKWebView` there. Shared Rust may emit a one-way top-level entry route toward
React Router; Web content owns every internal route, history entry, back action,
and DOM focus. The WebView must not install a script message handler or other
Web-to-Native command bridge.

Open `MishShellPrototype.swiftpm` in Xcode 26 or later, select an iOS 26 or
iPadOS 26 simulator, and run **Mish Shell Prototype**. The package intentionally
uses standard system navigation components so the installed OS owns Liquid
Glass rendering and accessibility adaptation.

The 2026-08-03 research host had only Apple Command Line Tools. Xcode, iOS SDKs,
and Simulator were unavailable, so this candidate was not compiled or run on
that host. Do not promote it beyond source-ready prototype evidence until the
documented simulator and accessibility walkthrough passes.
