// swift-tools-version: 6.2

import AppleProductTypes
import PackageDescription

let package = Package(
    name: "MishShellPrototype",
    platforms: [.iOS("26.0")],
    products: [
        .iOSApplication(
            name: "Mish Shell Prototype",
            targets: ["AppModule"],
            bundleIdentifier: "com.asuka109.mish.shell-prototype",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .network),
            accentColor: .presetColor(.blue),
            supportedDeviceFamilies: [.phone, .pad],
            supportedInterfaceOrientations: [
                .portrait,
                .portraitUpsideDown,
                .landscapeRight,
                .landscapeLeft,
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "Sources"
        )
    ]
)
