// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "VenditBotCompanion",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CompanionCore", targets: ["CompanionCore"])],
    targets: [
        .target(name: "CompanionCore"),
        .testTarget(name: "CompanionCoreTests", dependencies: ["CompanionCore"])
    ]
)
