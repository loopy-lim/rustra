// UniFFI Swift 바인딩 런타임 스모크 — 커맨드라인 바이너리(iOS 시뮬레이터 타깃).
//
// 생성 바인딩(rustra_calculator_example.swift)과 같은 모듈로 컴파일되므로
// 별도 import 없이 심볼을 직접 호출한다. 바인딩이 요구하는 FFI 모듈
// (rustra_calculator_exampleFFI — modulemap + header)은 빌드 스크립트가
// -I 로 제공한다(canImport 분기 충족).
//
// 마커 계약(Android 스모크와 공유):
//   성공 — __RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42 를 정확히 한 번 출력.
//          타입 에러 경로(divide(10,0) 이 code == "math.divide_by_zero")까지
//          증명한 뒤에야 찍는다.
//   실패 — __RUSTRA_UNIFFI_FAIL__ <reason> 출력 후 exit 1.

import Foundation

func smokeFail(_ reason: String) -> Never {
    print("__RUSTRA_UNIFFI_FAIL__ \(reason)")
    exit(1)
}

// 1) 행복 경로 — addNumbers(20, 22) == 42
let sum: AddNumbersOutput
do {
    sum = try addNumbers(input: AddNumbersInput(a: 20, b: 22))
} catch {
    smokeFail("addNumbers threw: \(error)")
}
if sum.value != 42 {
    smokeFail("addNumbers(20,22) = \(sum.value), expected 42")
}

// 2) 타입 에러 경로 — divide(10, 0) 은 RustraCommandFailure.Failure 로 던져져야
//    하고 코드는 "math.divide_by_zero" 여야 한다. throw 가 없거나 코드가 다르면
//    실패다(조용한 통과 금지).
do {
    let out = try divide(input: DivideInput(a: 10, b: 0))
    smokeFail("divide(10,0) returned \(out.value), expected throw")
} catch let error as RustraCommandFailure {
    guard case let .Failure(code, _, _) = error, code == "math.divide_by_zero" else {
        smokeFail("divide(10,0) threw unexpected: \(error)")
    }
} catch {
    smokeFail("divide(10,0) threw non-RustraCommandFailure: \(error)")
}

// 두 경로가 모두 증명된 뒤에야 OK 마커를 찍는다.
print("__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42")
