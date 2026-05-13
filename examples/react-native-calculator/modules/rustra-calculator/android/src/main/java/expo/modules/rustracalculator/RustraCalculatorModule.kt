package expo.modules.rustracalculator

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RustraCalculatorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RustraCalculator")

    AsyncFunction("invokeRaw") { payload: String ->
      """{"ok":false,"error":"Android Rust transport is not implemented yet","payload":$payload}"""
    }

    Function("invokeRawSync") { payload: String ->
      """{"ok":false,"error":"Android Rust transport is not implemented yet","payload":$payload}"""
    }
  }
}
