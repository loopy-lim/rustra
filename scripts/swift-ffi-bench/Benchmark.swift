import Foundation

// Rust FFI declarations — mirrors rustra_calculator_example lib.rs
@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)

// ── Helpers ──────────────────────────────────────────────

func bar(_ value: Double, _ max: Double, width: Int = 40) -> String {
    let filled = Int(round(value / max * Double(width)))
    let f = Swift.max(filled, 1)
    return String(repeating: "█", count: f) + String(repeating: "░", count: width - f)
}

func formatNanos(_ ns: Double) -> String {
    if ns >= 1_000_000 { return String(format: "%.2f ms", ns / 1_000_000) }
    if ns >= 1_000 { return String(format: "%.1f µs", ns / 1_000) }
    return String(format: "%.0f ns", ns)
}

func pad(_ s: String, _ len: Int) -> String {
    s.padding(toLength: len, withPad: " ", startingAt: 0)
}

func formatNumber(_ n: Double) -> String {
    let s = String(format: "%.0f", n)
    var result = ""
    let chars = Array(s)
    for (i, c) in chars.enumerated() {
        if i > 0 && (chars.count - i) % 3 == 0 { result += "," }
        result.append(c)
    }
    return result
}

func measure(label: String, iterations: Int = 100_000, _ block: () -> Void) -> (avg: Double, p50: Double, p99: Double) {
    // Warm up
    for _ in 0..<1000 { block() }

    var times: [Double] = []
    times.reserveCapacity(iterations)
    for _ in 0..<iterations {
        let start = DispatchTime.now()
        block()
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds)
        times.append(elapsed)
    }
    times.sort()

    let avg = times.reduce(0, +) / Double(times.count)
    let p50 = times[Int(Double(times.count - 1) * 0.50)]
    let p99 = times[Int(Double(times.count - 1) * 0.99)]

    return (avg, p50, p99)
}

// ── Main ─────────────────────────────────────────────────

print("╔══════════════════════════════════════════════════════════╗")
print("║        rustra-bridge RN Layer Benchmark (Swift FFI)     ║")
print("╚══════════════════════════════════════════════════════════╝")
print()

// ── 1. FFI Call Overhead ─────────────────────────────────

print("┌─ FFI Call (Swift → Rust C FFI) ────────────────────────┐")

let simplePayload = "{\"command\":\"addNumbers\",\"args\":{\"a\":42,\"b\":58}}"

let ffiResult = measure(label: "FFI invoke") {
    let result = simplePayload.withCString { ptr in
        let response = rustra_calculator_invoke(ptr)
        defer { rustra_calculator_free_string(response) }
        return String(cString: response!)
    }
    _ = result
}

print("│  100,000 iterations")
print("│  avg: \(formatNanos(ffiResult.avg))  p50: \(formatNanos(ffiResult.p50))  p99: \(formatNanos(ffiResult.p99))")
print("└─────────────────────────────────────────────────────────┘")
print()

// ── 2. Full Bridge (Swift: JSON → FFI → parse) ───────────

print("┌─ Full Bridge (serialize → FFI → deserialize) ─────────┐")

let bridgeResult = measure(label: "Full bridge") {
    let payload: [String: Any] = ["command": "addNumbers", "args": ["a": 42, "b": 58]]
    let jsonData = try! JSONSerialization.data(withJSONObject: payload)
    let jsonString = String(data: jsonData, encoding: .utf8)!

    let resultStr = jsonString.withCString { ptr in
        let response = rustra_calculator_invoke(ptr)
        defer { rustra_calculator_free_string(response) }
        return String(cString: response!)
    }

    let resultData = resultStr.data(using: .utf8)!
    let parsed = try! JSONSerialization.jsonObject(with: resultData) as! [String: Any]
    _ = parsed
}

print("│  100,000 iterations")
print("│  avg: \(formatNanos(bridgeResult.avg))  p50: \(formatNanos(bridgeResult.p50))  p99: \(formatNanos(bridgeResult.p99))")
print("└─────────────────────────────────────────────────────────┘")
print()

// ── 3. Payload Size Scaling via FFI ──────────────────────

print("┌─ Payload Scaling (FFI) ───────────────────────────────┐")

let sizes = [1, 10, 50, 100]
var scalingResults: [(count: Int, avg: Double, jsonBytes: Int)] = []

for count in sizes {
    let items = (0..<count).map { i -> [String: Any] in
        return ["id": i, "name": "item-\(i)", "tags": ["a", "b"], "active": true, "score": Double(i) * 1.5]
    }
    let payload: [String: Any] = ["command": "processPayload", "args": ["items": items]]
    let jsonData = try! JSONSerialization.data(withJSONObject: payload)
    let jsonString = String(data: jsonData, encoding: .utf8)!

    let result = measure(label: "\(count) items", iterations: 10_000) {
        let _ = jsonString.withCString { ptr in
            let response = rustra_calculator_invoke(ptr)
            rustra_calculator_free_string(response)
        }
    }
    scalingResults.append((count, result.avg, jsonData.count))
}

let maxAvg = scalingResults.map(\.avg).max()!

print("│  \(pad("Items", 8)) \(pad("JSON bytes", 10)) \(pad("Avg", 10))  ")
print("│  \(pad("─────", 8)) \(pad("─────────", 10)) \(pad("────────", 10))  ")
for r in scalingResults {
    let b = bar(r.avg, maxAvg, width: 30)
    print("│  \(pad(String(r.count), 8)) \(pad(String(r.jsonBytes), 10)) \(pad(formatNanos(r.avg), 10))  \(b)")
}
print("└─────────────────────────────────────────────────────────┘")
print()

// ── 4. Comparison: pure JSON vs full FFI ──────────────────

print("┌─ Overhead Breakdown (per call) ────────────────────────┐")

let jsonOnly = measure(label: "JSON roundtrip only", iterations: 100_000) {
    let payload: [String: Any] = ["command": "addNumbers", "args": ["a": 42, "b": 58]]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    let str = String(data: data, encoding: .utf8)!
    let parsed = try! JSONSerialization.jsonObject(with: str.data(using: .utf8)!)
    _ = parsed
}

// 측정 기반 분해 — Swift JSONSerialization(NSDictionary) 왕복이 Codable 보다
// 훨씬 비싸므로, FFI+Rust 코어 층은 FFI invoke 측정치 그대로 보고한다
// (JSON 왕복 층과 독립 측정이라 차감 분해가 아니라 측정값 나열이 정확).
// 과거 산식은 차감에 `+ ffiResult.avg * 0.3` 인위 보정이 섞여 음수
// 레이어(-2952ns)를 출력했다.
let layers: [(String, Double, String)] = [
    ("Swift JSON roundtrip only", jsonOnly.avg, "▓"),
    ("Swift ↔ Rust FFI + Rust core", ffiResult.avg, "▒"),
    ("Bridge total (serialize+FFI+parse)", bridgeResult.avg, "█"),
]

let maxLayer = layers.map(\.1).max()!
for (name, ns, ch) in layers {
    let b = String(repeating: ch, count: max(1, Int(ns / maxLayer * 35)))
    print("│  \(name.padding(toLength: 30, withPad: " ", startingAt: 0)) \(b.padding(toLength: 35, withPad: " ", startingAt: 0)) \(formatNanos(ns))")
}

print("│")
print("│  Total bridge latency: \(formatNanos(bridgeResult.avg))")
print("└─────────────────────────────────────────────────────────┘")
print()

// ── 5. Throughput ────────────────────────────────────────

print("┌─ Throughput (FFI, single-threaded) ───────────────────┐")
let throughputIters = 500_000
let start = DispatchTime.now()
for _ in 0..<throughputIters {
    let response = simplePayload.withCString { ptr in rustra_calculator_invoke(ptr) }
    rustra_calculator_free_string(response)
}
let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds)
let opsPerSec = Double(throughputIters) / (elapsed / 1_000_000_000)

print("│  \(throughputIters) iterations in \(formatNanos(elapsed))")
let formatted = formatNumber(opsPerSec)
print("│  \(formatted) ops/sec")

let barW = 50
let filled = Int(min(1.0, opsPerSec / 10_000_000.0) * Double(barW))
let tb = String(repeating: "█", count: filled) + String(repeating: "░", count: barW - filled)
print("│  [\(tb)]")
print("│  0                                               10M ops/s")
print("└─────────────────────────────────────────────────────────┘")
