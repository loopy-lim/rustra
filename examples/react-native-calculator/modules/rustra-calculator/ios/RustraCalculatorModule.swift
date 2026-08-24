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
  private func encodePayload(command: String, args: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(args),
          let data = try? JSONSerialization.data(
            withJSONObject: ["command": command, "args": args]
          )
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func definition() -> ModuleDefinition {
    Name("RustraCalculator")

    AsyncFunction("invokeRaw") { (payload: String, promise: Promise) in
      let resultPtr = rustra_calculator_invoke(payload)
      guard let ptr = resultPtr else {
        promise.reject("ERR_INVOKE", "Rust invoke returned nil")
        return
      }
      defer { rustra_calculator_free_string(ptr) }
      let result = String(cString: ptr)
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
      let resultPtr = rustra_calculator_invoke(payload)
      guard let ptr = resultPtr else { return 0 }
      defer { rustra_calculator_free_string(ptr) }
      let resultStr = String(cString: ptr)
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
      let resultPtr = rustra_calculator_invoke(payload)
      guard let ptr = resultPtr else { return "{\"ok\":false,\"error\":\"invoke returned nil\"}" }
      defer { rustra_calculator_free_string(ptr) }
      return String(cString: ptr)
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

@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)
