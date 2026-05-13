import ExpoModulesCore

@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)

public class RustraCalculatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RustraCalculator")

    AsyncFunction("invokeRaw") { (payload: String) -> String in
      return payload.withCString { pointer in
        decodeRustString(rustra_calculator_invoke(pointer))
      }
    }

    Function("invokeRawSync") { (payload: String) -> String in
      return payload.withCString { pointer in
        decodeRustString(rustra_calculator_invoke(pointer))
      }
    }
  }
}

private func decodeRustString(_ ptr: UnsafeMutablePointer<CChar>?) -> String {
  guard let ptr else {
    return #"{"ok":false,"error":"Rust returned null"}"#
  }

  let text = String(cString: ptr)
  rustra_calculator_free_string(ptr)
  return text
}
