// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Sotto",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure logic: settings model and text post-processing. No AppKit, so it is unit-tested.
        .target(name: "SottoCore", path: "Sources/SottoCore"),
        .executableTarget(name: "Sotto", dependencies: ["SottoCore"], path: "Sources/Sotto"),
        .testTarget(name: "SottoCoreTests", dependencies: ["SottoCore"], path: "Tests/SottoCoreTests"),
    ]
)
