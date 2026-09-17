import Foundation

@main
struct ReceiptWriterTest {
  static func main() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let legacy = #"{"contract":"rustra-benchmark/v1","value":"legacy"}"#
    let v1 = #"{"contract":"rustra-nitro-parity/v1","value":"old parity"}"#
    let v2 = #"{"contract":"rustra-nitro-parity/v2","value":"new parity"}"#
    func check(_ value: Bool) { precondition(value) }
    func contents(_ name: String) throws -> String {
      try String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8)
    }
    func write(_ value: String, expected: String) throws {
      let filename = try BenchmarkReceiptWriter.write(value, to: directory)
      guard filename == expected else {
        throw NSError(domain: "receipt filename", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "expected \(expected), got \(filename)"])
      }
      check(try contents(expected) == value)
    }
    try write(legacy, expected: "rustra-benchmark-receipt.json")
    try write(v1, expected: "rustra-nitro-parity.json")
    check(try contents("rustra-benchmark-receipt.json") == legacy)
    try write(v2, expected: "rustra-nitro-parity.json")
    check(try contents("rustra-benchmark-receipt.json") == legacy)
    try write(legacy, expected: "rustra-benchmark-receipt.json")
    check(try contents("rustra-nitro-parity.json") == v2)
    try write(#"{"contract":"rustra-nitro-parity/v3"}"#, expected: "rustra-benchmark-receipt.json")
    check(try contents("rustra-nitro-parity.json") == v2)
    for invalid in ["[]", "invalid", String(repeating: " ", count: 8 * 1024 * 1024 + 1)] {
      var rejected = false
      do { _ = try BenchmarkReceiptWriter.write(invalid, to: directory) } catch { rejected = true }
      check(rejected)
      check(try contents("rustra-nitro-parity.json") == v2)
    }
    print("PASS: v1/v2/legacy routing, cross-file preservation and rejected writes")
  }
}
