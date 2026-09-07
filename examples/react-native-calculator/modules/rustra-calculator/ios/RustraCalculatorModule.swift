import ExpoModulesCore
import Foundation

private enum BenchmarkReceiptError: LocalizedError {
  case invalidJSON
  case tooLarge

  var errorDescription: String? {
    switch self {
    case .invalidJSON:
      return "benchmark receipt must be a JSON object"
    case .tooLarge:
      return "benchmark receipt exceeds the 8 MiB safety limit"
    }
  }
}

public class RustraCalculatorModule: Module {
  /// Core `rustra_ffi_invoke_json` contract: UTF-8 request bytes in
  /// (`{"command":...,"args":...}`), JSON envelope bytes out
  /// (`{"ok":Bool,"result":...,"error":...}`). Response buffers are allocated
  /// by the core FFI allocator — release them only through `rustra_ffi_free`.
  private func encodePayload(command: String, args: Any) -> [UInt8]? {
    guard JSONSerialization.isValidJSONObject(args),
          let data = try? JSONSerialization.data(
            withJSONObject: ["command": command, "args": args]
          )
    else { return nil }
    return Array(data)
  }

  /// Decodes an invoke_json response envelope into a UTF-8 string.
  private func envelopeString(ptr: UnsafeMutablePointer<UInt8>, count: Int) -> String {
    let bytes = UnsafeBufferPointer(start: ptr, count: count)
    return String(decoding: bytes, as: UTF8.self)
  }

  public func definition() -> ModuleDefinition {
    Name("RustraCalculator")

    AsyncFunction("invokeRaw") { (payload: String, promise: Promise) in
      let data = Array(payload.utf8)
      var outLen = 0
      let resultPtr = rustra_ffi_invoke_json(data, data.count, &outLen)
      guard let ptr = resultPtr else {
        promise.reject("ERR_INVOKE", "Rust invoke returned nil")
        return
      }
      defer { rustra_ffi_free(ptr, outLen) }
      let result = self.envelopeString(ptr: ptr, count: outLen)
      promise.resolve(result)
    }

    Function("addSync") { (a: Double, b: Double) -> Double in
      let int64LowerBound = -9_223_372_036_854_775_808.0
      let int64UpperBound = 9_223_372_036_854_775_808.0
      guard a.isFinite, b.isFinite,
            a.rounded(.towardZero) == a, b.rounded(.towardZero) == b,
            a >= int64LowerBound, a < int64UpperBound,
            b >= int64LowerBound, b < int64UpperBound,
            let payload = self.encodePayload(
              command: "addNumbers",
              args: ["a": Int64(a), "b": Int64(b)]
            )
      else { return 0 }
      var outLen = 0
      let resultPtr = rustra_ffi_invoke_json(payload, payload.count, &outLen)
      guard let ptr = resultPtr else { return 0 }
      defer { rustra_ffi_free(ptr, outLen) }
      let resultStr = self.envelopeString(ptr: ptr, count: outLen)
      guard let data = resultStr.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let ok = json["ok"] as? Bool, ok,
            let result = json["result"] as? [String: Any],
            let value = result["value"] as? NSNumber
      else { return 0 }
      return value.doubleValue
    }

    Function("invokeSync") { (command: String, argsJson: String?) -> String in
      let argsData = (argsJson ?? "{}").data(using: .utf8)
      guard let argsData,
            let args = try? JSONSerialization.jsonObject(with: argsData),
            let payload = self.encodePayload(command: command, args: args)
      else { return "{\"ok\":false,\"error\":\"invalid arguments JSON\"}" }
      var outLen = 0
      let resultPtr = rustra_ffi_invoke_json(payload, payload.count, &outLen)
      guard let ptr = resultPtr else { return "{\"ok\":false,\"error\":\"invoke returned nil\"}" }
      defer { rustra_ffi_free(ptr, outLen) }
      return self.envelopeString(ptr: ptr, count: outLen)
    }

    // Benchmark-only receipt export. The stable filename lets a Bun host
    // runner resolve the app data container with simctl and collect the exact
    // JSON without scraping console output or screenshots.
    Function("writeBenchmarkReceipt") { (receipt: String) throws -> String in
      let data = Data(receipt.utf8)
      guard data.count <= 8 * 1024 * 1024 else { throw BenchmarkReceiptError.tooLarge }
      guard let object = try? JSONSerialization.jsonObject(with: data),
            object is [String: Any]
      else { throw BenchmarkReceiptError.invalidJSON }

      let documents = try FileManager.default.url(
        for: .documentDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      let destination = documents.appendingPathComponent("rustra-benchmark-receipt.json")
      try data.write(to: destination, options: .atomic)
      return destination.lastPathComponent
    }
  }
}

@_silgen_name("rustra_ffi_invoke_json")
func rustra_ffi_invoke_json(
  _ payload: UnsafePointer<UInt8>,
  _ len: Int,
  _ outLen: UnsafeMutablePointer<Int>
) -> UnsafeMutablePointer<UInt8>?

@_silgen_name("rustra_ffi_free")
func rustra_ffi_free(_ ptr: UnsafeMutablePointer<UInt8>?, _ len: Int)
