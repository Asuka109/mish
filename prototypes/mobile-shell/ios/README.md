# iOS and iPadOS shell prototype

This research-only Swift package exercises system `TabView`,
`NavigationStack`, adaptable sidebar presentation, navigation and toolbar
materials, scroll-edge behavior, sheets, Dynamic Type, VoiceOver focus,
Reduce Motion, Reduce Transparency, pointer hover, keyboard shortcuts, and
compact or regular layouts. It contains no Mish product runtime and is not
linked into the Tauri application.

Open `MishShellPrototype.swiftpm` in Xcode 26 or later, select an iOS 26 or
iPadOS 26 simulator, and run **Mish Shell Prototype**. The package intentionally
uses standard system navigation components so the installed OS owns Liquid
Glass rendering and accessibility adaptation.

The 2026-08-03 research host had only Apple Command Line Tools. Xcode, iOS SDKs,
and Simulator were unavailable, so this candidate was not compiled or run on
that host. Do not promote it beyond source-ready prototype evidence until the
documented simulator and accessibility walkthrough passes.
