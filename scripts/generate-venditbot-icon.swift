// Original code-native VenditBot artwork; same geometry as resources/venditbot-icon.svg.
// Run through generate-venditbot-icon.mjs. AppKit renders local PNGs; no network/fonts/assets.
import AppKit

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: generate-venditbot-icon.swift <output.iconset>\n", stderr)
    exit(1)
}
let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)

func render(pixels: Int, name: String) throws {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                                  bytesPerRow: pixels * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw NSError(domain: "VenditBotIcon", code: 1)
    }
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    // Match the SVG's top-left coordinate system.
    context.translateBy(x: 0, y: CGFloat(pixels))
    let scale = CGFloat(pixels) / 1024
    context.scaleBy(x: scale, y: -scale)
    context.setFillColor(CGColor(srgbRed: 77.0 / 255.0, green: 36.0 / 255.0, blue: 226.0 / 255.0, alpha: 1))
    context.addPath(CGPath(roundedRect: CGRect(x: 96, y: 96, width: 832, height: 832), cornerWidth: 188, cornerHeight: 188, transform: nil))
    context.fillPath()
    let points: [CGPoint] = [CGPoint(x: 280, y: 302), CGPoint(x: 422, y: 302), CGPoint(x: 514, y: 592), CGPoint(x: 606, y: 302), CGPoint(x: 748, y: 302), CGPoint(x: 583, y: 738), CGPoint(x: 445, y: 738)]
    context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    context.addLines(between: points)
    context.closePath()
    context.fillPath()
    guard let image = context.makeImage(), let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw NSError(domain: "VenditBotIcon", code: 2)
    }
    try png.write(to: destination.appendingPathComponent(name), options: .atomic)
}

for points in [16, 32, 128, 256, 512] {
    try render(pixels: points, name: "icon_\(points)x\(points).png")
    try render(pixels: points * 2, name: "icon_\(points)x\(points)@2x.png")
}
print("Rendered VenditBot iconset at \(destination.path)")
