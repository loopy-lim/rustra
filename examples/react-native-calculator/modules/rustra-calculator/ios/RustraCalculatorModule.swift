import ExpoModulesCore
import Foundation

@objc(RustraCalculatorModule)
public class RustraCalculatorModule: ExpoModule {
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
      let payload = "{\"command\":\"addNumbers\",\"args\":{\"a\":\(Int64(a)),\"b\":\(Int64(b))}}"
      let resultPtr = rustra_calculator_invoke(payload)
      guard let ptr = resultPtr else { return 0 }
      defer { rustra_calculator_free_string(ptr) }
      let resultStr = String(cString: ptr)
      guard let data = resultStr.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let ok = json["ok"] as? Bool, ok,
            let value = json["result"] as? Int64
      else { return 0 }
      return Double(value)
    }

    Function("invokeSync") { (command: String, argsJson: String?) -> String in
      let args = argsJson ?? "{}"
      let payload = "{\"command\":\"\(command)\",\"args\":\(args)}"
      let resultPtr = rustra_calculator_invoke(payload)
      guard let ptr = resultPtr else { return "{\"ok\":false,\"error\":\"invoke returned nil\"}" }
      defer { rustra_calculator_free_string(ptr) }
      return String(cString: ptr)
    }
  }
}

@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)
