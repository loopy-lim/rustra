import Foundation

// All rows execute addNumbers(42, 58) = 100. The primitive ABI row is a lower
// bound only; the remaining rows compare rustra transport/allocation layers.
@_silgen_name("rustra_calculator_add_direct")
func rustra_calculator_add_direct(_ a: Int64, _ b: Int64) -> Int64

@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)

@_silgen_name("rustra_ffi_invoke_rkyv_v2")
func rustra_ffi_invoke_rkyv_v2(
    _ payload: UnsafePointer<UInt8>?,
    _ payloadLen: UInt,
    _ outLen: UnsafeMutablePointer<UInt>?
) -> UnsafeMutablePointer<UInt8>?

@_silgen_name("rustra_ffi_invoke_rkyv_v2_into")
func rustra_ffi_invoke_rkyv_v2_into(
    _ payload: UnsafePointer<UInt8>?,
    _ payloadLen: UInt,
    _ buffer: UnsafeMutablePointer<UInt8>?,
    _ capacity: UInt,
    _ outLen: UnsafeMutablePointer<UInt>?
) -> UInt

@_silgen_name("rustra_ffi_free")
func rustra_ffi_free(_ ptr: UnsafeMutablePointer<UInt8>?, _ len: UInt)

struct BenchResult {
    let label: String
    let avg: Double
    let p50: Double
    let p99: Double

    var opsPerSecond: Double { 1_000_000_000 / avg }
}

let iterations = Int(ProcessInfo.processInfo.environment["RUSTRA_BENCH_ITERATIONS"] ?? "100000")!
let warmup = Int(ProcessInfo.processInfo.environment["RUSTRA_BENCH_WARMUP"] ?? "1000")!
let jsonOnly = CommandLine.arguments.contains("--json")

func measure(_ label: String, _ block: () -> Void) -> BenchResult {
    for _ in 0..<warmup { block() }
    var times: [Double] = []
    times.reserveCapacity(iterations)
    for _ in 0..<iterations {
        let start = DispatchTime.now().uptimeNanoseconds
        block()
        times.append(Double(DispatchTime.now().uptimeNanoseconds - start))
    }
    times.sort()
    return BenchResult(
        label: label,
        avg: times.reduce(0, +) / Double(times.count),
        p50: times[Int(Double(times.count - 1) * 0.50)],
        p99: times[Int(Double(times.count - 1) * 0.99)]
    )
}

func formatNanos(_ ns: Double) -> String {
    if ns >= 1_000_000 { return String(format: "%.2f ms", ns / 1_000_000) }
    if ns >= 1_000 { return String(format: "%.2f µs", ns / 1_000) }
    return String(format: "%.0f ns", ns)
}

func decodeZigzag(_ bytes: ArraySlice<UInt8>) -> Int64 {
    var value: UInt64 = 0
    var shift: UInt64 = 0
    for byte in bytes {
        value |= UInt64(byte & 0x7f) << shift
        if byte & 0x80 == 0 { break }
        shift += 7
    }
    return Int64(value >> 1) ^ -Int64(value & 1)
}

let jsonRequest = "{\"command\":\"addNumbers\",\"args\":{\"a\":42,\"b\":58}}"
// [command_id=1 LE][postcard zigzag(42)][postcard zigzag(58)]
let rkyvRequest: [UInt8] = [0x01, 0x00, 0x54, 0x74]

func legacyJSONCall() {
    jsonRequest.withCString { request in
        let response = rustra_calculator_invoke(request)
        precondition(response != nil)
        rustra_calculator_free_string(response)
    }
}

func rkyvAllocCall() {
    rkyvRequest.withUnsafeBytes { raw in
        var outLen: UInt = 0
        let response = rustra_ffi_invoke_rkyv_v2(
            raw.bindMemory(to: UInt8.self).baseAddress,
            UInt(raw.count),
            &outLen
        )
        precondition(response != nil && outLen >= 9)
        rustra_ffi_free(response, outLen)
    }
}

var reusable = [UInt8](repeating: 0, count: 64)
func rkyvIntoCall(probe: Bool) {
    rkyvRequest.withUnsafeBytes { requestRaw in
        reusable.withUnsafeMutableBytes { outputRaw in
            let request = requestRaw.bindMemory(to: UInt8.self)
            let output = outputRaw.bindMemory(to: UInt8.self)
            var outLen: UInt = 0
            if probe {
                let result = rustra_ffi_invoke_rkyv_v2_into(
                    request.baseAddress,
                    UInt(request.count),
                    nil,
                    0,
                    &outLen
                )
                precondition(result == 0 && outLen <= UInt(output.count))
            }
            let written = rustra_ffi_invoke_rkyv_v2_into(
                request.baseAddress,
                UInt(request.count),
                output.baseAddress,
                UInt(output.count),
                &outLen
            )
            precondition(written != UInt.max && written == outLen)
        }
    }
}

// Matches RustraJSIBridge.cpp: try the common small response in one call,
// then retry with the exact required capacity only when the stack-sized buffer
// is too small. The Rust FFI caches that oversized response, so the handler is
// still executed exactly once.
var stackFirstBuffer = [UInt8](repeating: 0, count: 512)
func rkyvStackFirstCall() {
    rkyvRequest.withUnsafeBytes { requestRaw in
        let request = requestRaw.bindMemory(to: UInt8.self)
        var outLen: UInt = 0
        let written = stackFirstBuffer.withUnsafeMutableBytes { outputRaw in
            let output = outputRaw.bindMemory(to: UInt8.self)
            return rustra_ffi_invoke_rkyv_v2_into(
                request.baseAddress,
                UInt(request.count),
                output.baseAddress,
                UInt(output.count),
                &outLen
            )
        }

        guard written == UInt.max else {
            precondition(written == outLen)
            return
        }

        var exactBuffer = [UInt8](repeating: 0, count: Int(outLen))
        let retried = exactBuffer.withUnsafeMutableBytes { outputRaw in
            let output = outputRaw.bindMemory(to: UInt8.self)
            return rustra_ffi_invoke_rkyv_v2_into(
                request.baseAddress,
                UInt(request.count),
                output.baseAddress,
                UInt(output.count),
                &outLen
            )
        }
        precondition(retried != UInt.max && retried == outLen)
    }
}

// Correctness gate before timing.
precondition(rustra_calculator_add_direct(42, 58) == 100)
let legacyResponse = jsonRequest.withCString { request -> String in
    let response = rustra_calculator_invoke(request)!
    defer { rustra_calculator_free_string(response) }
    return String(cString: response)
}
precondition(legacyResponse.contains("\"value\":100"))
rkyvIntoCall(probe: true)
precondition(reusable[0] == 1 && decodeZigzag(reusable[8...]) == 100)
rkyvStackFirstCall()
precondition(stackFirstBuffer[0] == 1 && decodeZigzag(stackFirstBuffer[8...]) == 100)

let direct = measure("primitive C ABI lower bound") {
    precondition(rustra_calculator_add_direct(42, 58) == 100)
}
let legacy = measure("legacy JSON CString alloc/free") { legacyJSONCall() }
let rkyvAlloc = measure("rkyv V2 alloc/free") { rkyvAllocCall() }
let rkyvInto = measure("rkyv V2 caller buffer (reused)") { rkyvIntoCall(probe: false) }
let rkyvProbeInto = measure("rkyv V2 probe + caller buffer") { rkyvIntoCall(probe: true) }
let rkyvStackFirst = measure("rkyv V2 stack-first caller buffer (actual JSI protocol)") {
    rkyvStackFirstCall()
}
let fullJSON = measure("Swift JSON encode + FFI + decode") {
    let payload: [String: Any] = ["command": "addNumbers", "args": ["a": 42, "b": 58]]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    let request = String(data: data, encoding: .utf8)!
    let response = request.withCString { pointer -> String in
        let result = rustra_calculator_invoke(pointer)!
        defer { rustra_calculator_free_string(result) }
        return String(cString: result)
    }
    let parsed = try! JSONSerialization.jsonObject(with: Data(response.utf8)) as! [String: Any]
    precondition(parsed["ok"] as? Bool == true)
}

let results = [direct, legacy, rkyvAlloc, rkyvInto, rkyvProbeInto, rkyvStackFirst, fullJSON]
let report: [String: Any] = [
    "schemaVersion": 1,
    "benchmark": "swift-rust-ffi-addNumbers",
    "timestamp": ISO8601DateFormatter().string(from: Date()),
    "iterations": iterations,
    "warmup": warmup,
    "request": ["command": "addNumbers", "a": 42, "b": 58, "expected": 100],
    "results": results.map { result in
        [
            "label": result.label,
            "avgNs": result.avg,
            "p50Ns": result.p50,
            "p99Ns": result.p99,
            "opsPerSecond": result.opsPerSecond,
        ]
    },
]
let reportData = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
let reportJSON = String(data: reportData, encoding: .utf8)!

if jsonOnly {
    print(reportJSON)
} else {
    print("rustra Swift ↔ Rust FFI ladder")
    print("same command: addNumbers(42, 58) = 100; \(iterations) iterations, \(warmup) warmup")
    print(String(repeating: "-", count: 92))
    for result in results {
        let name = result.label.padding(toLength: 38, withPad: " ", startingAt: 0)
        print("\(name) avg \(formatNanos(result.avg))  p50 \(formatNanos(result.p50))  p99 \(formatNanos(result.p99))")
    }
    print(String(repeating: "-", count: 92))
    print("The primitive row is a lower bound, not a framework-to-framework comparison.")
    print("RUSTRA_BENCH_JSON=\(reportJSON)")
}
