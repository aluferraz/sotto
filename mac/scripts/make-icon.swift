// Draws the app icon and writes an .iconset folder: swift scripts/make-icon.swift OUT.iconset
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ pixels: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(pixels)
    let inset = s * 0.1
    let tile = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    NSGradient(colors: [
        NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.24, alpha: 1),
        NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.08, alpha: 1),
    ])!.draw(in: shape, angle: -90)

    // A waveform that rises and falls: quiet speech in the middle of a sentence.
    let heights: [CGFloat] = [0.14, 0.30, 0.52, 0.34, 0.70, 0.46, 0.24, 0.12]
    let barWidth = tile.width * 0.058
    let gap = tile.width * 0.040
    let total = CGFloat(heights.count) * barWidth + CGFloat(heights.count - 1) * gap
    var x = tile.midX - total / 2
    for (i, h) in heights.enumerated() {
        let height = tile.height * h
        let bar = NSRect(x: x, y: tile.midY - height / 2, width: barWidth, height: height)
        let warm = CGFloat(i) / CGFloat(heights.count - 1)
        NSColor(calibratedRed: 1.0, green: 0.78 - 0.25 * warm, blue: 0.45 - 0.1 * warm, alpha: 1).setFill()
        NSBezierPath(roundedRect: bar, xRadius: barWidth / 2, yRadius: barWidth / 2).fill()
        x += barWidth + gap
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = "icon_\(points)x\(points)" + (scale == 2 ? "@2x" : "") + ".png"
    try render(points * scale).write(to: out.appendingPathComponent(name))
}
