// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Greeter",
    targets: [
        .target(name: "Greeter"),
        .testTarget(name: "GreeterTests", dependencies: ["Greeter"]),
    ]
)
