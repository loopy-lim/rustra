English | [English](./wire-format.md)

# 와이어 포맷 — 명칭과 실측 범위

"rkyv V2"는 Rustra 자체 프레임/프로토콜 이름이다. upstream `rkyv` 아카이브
포맷과 바이트 수준 호환된다는 주장이 아니다: manifest/dispatch 경로의 payload
코덱은 postcard이며, upstream rkyv 아카이브와의 호환은 별도 검증 없이 동일하다고
표기하지 않는다. 이 문서는 명칭과 실측 수치를 분리해 어느 쪽도 범위를 넘어
인용되지 않게 한다.

## 명칭

| 이름                 | 실제 의미                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| rkyv V2              | Rustra의 바이너리 프레임 프로토콜(V2 프레이밍 + command id + postcard payload 코덱). 내부 명칭. |
| postcard             | manifest/dispatch 경로에서 쓰이는 payload 코덱(serde 호환 컴팩트 포맷).                         |
| JSON 와이어          | codecs 미주입 어댑터가 쓰는 `invoke_json`/stdio 라인 프로토콜.                                  |
| zero-copy (JSI 경로) | RN JSI 패스트패스가 네이티브 버퍼 뷰를 JS 사본 없이 JS 코덱에 전달.                             |

"zero-copy"는 특정 한 번의 복사가 제거된다는 뜻이다: 네이티브 호출 경계와 코덱
사이의 JS 측 버퍼 사본. 왕복 전체가 할당 없다는 의미가 아니며 JSON 와이어에는
적용되지 않는다. 실측 사례는 Bun `toArrayBuffer` 뷰 함정(FFI 버퍼의 뷰는 호출을
넘어 살아있으면 안 된다)이며 경계 상세는 docs/benchmarks.md 를 본다.

## 11.8× / 47B 수치의 범위

"JSON보다 11.8× 작다" 수치는 대표 커맨드 payload(add 커맨드)의 **요청 와이어
바이트** 기준이다 — 같은 args 를 postcard 인코딩 vs `JSON.stringify`, 47B vs
약 560B. 분모는 요청 바이트뿐이며 프레이밍·전송 오버헤드·응답은 제외다.
엔드투엔드 RTT 주장이 아니다.

| 계층           | 변하는 것                           | 측정 위치                                 |
| -------------- | ----------------------------------- | ----------------------------------------- |
| payload 와이어 | args 의 postcard vs JSON 인코딩     | 요청 payload — 11.8× 수치                 |
| 코어 dispatch  | 레지스트리 조회 + 핸들러 호출       | Rust criterion 벤치(`cargo bench`)        |
| FFI 경계       | 네이티브 lib 출입 인자 마샬링       | caller-buffer 벤치(packages/bun)          |
| 엔드투엔드 RTT | 위 전부 + transport + host 스케줄링 | docs/benchmarks.md 호스트 매트릭스 수령증 |

수치를 인용할 때는 계층을 명명하라. payload 배율을 RTT 배율로, FFI 마이크로
수치를 사용자 경로 지연으로 인용하지 않는다.
