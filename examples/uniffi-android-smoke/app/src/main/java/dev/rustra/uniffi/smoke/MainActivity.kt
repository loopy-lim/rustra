package dev.rustra.uniffi.smoke

import android.app.Activity
import android.os.Bundle
import android.util.Log
import uniffi.rustra_calculator_example.AddNumbersInput
import uniffi.rustra_calculator_example.DivideInput
import uniffi.rustra_calculator_example.RustraCommandFailure
import uniffi.rustra_calculator_example.addNumbers
import uniffi.rustra_calculator_example.divide
import uniffi.rustra_calculator_example.uniffiEnsureInitialized

/**
 * UniFFI Kotlin 바인딩 런타임 스모크.
 *
 * 생성 바인딩(uniffi.rustra_calculator_example)과 Rust .so 가 실제 에뮬레이터에서
 * 로드·실행되는지 마커로 증명한다. 마커 계약(CI 와 공유):
 *   성공 — __RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42 를 정확히 한 번 출력.
 *          단, 행복 경로만으로는 부족하고 타입 에러 경로(divide(10,0) 이
 *          code == "math.divide_by_zero" 로 throw)까지 증명한 뒤에야 찍는다.
 *   실패 — __RUSTRA_UNIFFI_FAIL__ <reason> 출력.
 * 로그 레벨 규율: Log.i/d 가 아닌 Log.w 만 쓴다(Release 로그 레벨에서도 관측되게).
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            // checksum 검증이 포함된 초기화 — 바인딩과 .so 의 API 불일치를
            // 첫 호출 전에 즉시 드러낸다.
            uniffiEnsureInitialized()

            // 1) 행복 경로 — addNumbers(20, 22) == 42
            val sum = addNumbers(AddNumbersInput(a = 20, b = 22))
            if (sum.value != 42L) {
                throw IllegalStateException("addNumbers(20,22) = ${sum.value}, expected 42")
            }

            // 2) 타입 에러 경로 — divide(10, 0) 은 RustraCommandFailure.Failure 로
            //    던져져야 하고 코드는 "math.divide_by_zero" 여야 한다. throw 가
            //    없거나 코드가 다르면 실패다(조용한 통과 금지).
            try {
                val out = divide(DivideInput(a = 10, b = 0))
                throw IllegalStateException("divide(10,0) returned ${out.value}, expected throw")
            } catch (e: RustraCommandFailure.Failure) {
                if (e.code != "math.divide_by_zero") {
                    throw IllegalStateException(
                        "divide(10,0) code = ${e.code}, expected math.divide_by_zero",
                    )
                }
            }

            // 두 경로가 모두 증명된 뒤에야 OK 마커를 찍는다.
            Log.w(TAG, "__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42")
        } catch (t: Throwable) {
            Log.w(TAG, "__RUSTRA_UNIFFI_FAIL__ ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    private companion object {
        const val TAG = "RustraUniffiSmoke"
    }
}
