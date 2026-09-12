English | [English](./wire-format.md)

# 와이어 포맷 — 명칭과 실측 범위

"Frame"은 Rustra 자체 프레임/프로토콜 이름이다(구칭 "rkyv V2" — 예전 포스트나
CHANGELOG에서 오 독자를 위한 참고). manifest/dispatch 경로의 payload 코덱은
postcard이며, upstream `rkyv` 아카이브 포맷과는 무관하고 호환을 주장하지 않는다.
이 문서는 명칭과 실측 수치를 분리해 어느 쪽도 범위를 넘어 인용되지 않게 한다.

## 명칭

| 이름                 | 실제 의미                                                                            |
| -------------------- | ------------------------------------------------------------------------------------ |
| Frame                | Rustra의 바이너리 프레임 프로토콜(V2 프레이밍 + command id + postcard payload 코덱). |
| postcard             | manifest/dispatch 경로에서 쓰이는 payload 코덱(serde 호환 컴팩트 포맷).              |
| JSON 와이어          | codecs 미주입 어댑터가 쓰는 `invoke_json`/stdio 라인 프로토콜.                       |
| zero-copy (JSI 경로) | RN JSI 패스트패스가 네이티브 버퍼 뷰를 JS 사본 없이 JS 코덱에 전달.                  |

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

## loop-stdio 바이너리 모드 예약 프레임

loop-stdio 런타임은 요청/응답 프레임과 같은 길이 접두 스트림
(`[len u32 LE][cmd/본문]`)에 비자발 푸시와 채널 제어를 다중화한다. 응답
프레임은 ok 플래그 바이트(0/1)로 시작하므로 첫 `u16 LE` 가 예약 cmd id 와
절대 충돌하지 않는다 — 수신자 디멀티플렉서의 분기 근거가 이 와이어 사실이다.
예약 id (u16 상한부부터 하강):

| cmd id   | 방향                | 본문                                | 용도                                                        |
| -------- | ------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `0xFFFE` | 클라이언트 → 런타임 | (없음)                              | 이벤트 drain 요청                                           |
| `0xFFFD` | 런타임 → 클라이언트 | 1줄 JSON `{"name","payload","seq"}` | 이벤트 푸시 프레임                                          |
| `0xFFFC` | 런타임 → 클라이언트 | 1줄 JSON `{"handle","payload"}`     | JSON 채널 푸시 프레임                                       |
| `0xFFFB` | 클라이언트 → 런타임 | 없음 또는 `[mode u8]`               | 채널 발급 — `mode`: 없음/`0x00` = JSON, `0x01` = 바이트     |
| `0xFFFA` | 클라이언트 → 런타임 | postcard varint `u32` 핸들          | 채널 해제 (JSON/바이트 두 테이블에서 함께 제거)             |
| `0xFFF9` | 런타임 → 클라이언트 | `[handle u32 LE][payload bytes]`    | **바이너리 채널 푸시 프레임** (원시 바이트, JSON 래핑 없음) |

채널 발급 응답은 두 경로 모두 Frame 응답 셰이프에 `{"handle": u32}` JSON
본문을 실는다.

`0xFFF9` 본문은 페이로드를 원시 바이트(예: Frame)로 그대로 싣는다.
본문 안에 페이로드 길이 접두가 없다 — 프레임 래퍼의 `len` 이 이미 경계를
제공하며, JSON 채널 본문과 달리 자체 경계가 필요한 내부 구조도 없다. 한
핸들은 생성 시점의 `0xFFFB` 모드 바이트로 정확히 한 경로에서만 동작한다
(JSON xor bytes); 해제 프레임과 단조 핸들 공간은 두 경로가 공유한다.

`0xFFFB` 모드 바이트는 기존 프레임의 유일한 확장이다: 본문 없는 발급은
레거시 JSON 요청과 바이트 단위로 동일하므로 구 런타임과 구 클라이언트가 양
방향으로 호환된다(구 런타임은 본문을 전부 무시한다; 명시적 JSON `0x00` 플래그는
와이어 완전성을 위해 정의만 돼 있다). 알 수 없는 모드 값은 JSON 경로로 조용히
폴백하는 대신 `ok=0` 로 되돌린다. 새 클라이언트는 `__hello` 응답의
`"channelBytes": true` capability 로 바이너리 채널을 게이트한다 — 이를 에코하지
않는 런타임에서 `createNodeBytesChannel` 은 프레임을 보내기 전에
`channel.unavailable` 로 loud-fail 한다(JSON 경로와의 조용한 불일치 방지).
`0xFFF9` 프레임은 `mode=0x01` 발급을 한 클라이언트로만 흐르므로, 구
디멀티플렉서는 이를 절대 보지 않는다.

## 에러 프레임 (타입화 에러가 바꾸지 않는 것)

에러 응답은 다른 응답과 같은 프레임 래퍼에 `ok=0` 을 실을 뿐이다. Frame 경로는
`[ok=0][pad][len u16][postcard{code, message}]` 를, JSON 폴백은 `Display` 문자열을
`{code, message}` 로 되분할한다. 와이어의 에러 표면은 이게 전부이며 payload 필드도
선언 데이터도 없다.

커맨드별 타입화 에러(참조: [Rust API 가이드](./rust-api-guide.ko.md))는 여기를
건드리지 않는다. 선언은 schema.json 에 살고, 코드젠 시점에 생성 TypeScript
(`errors.ts` — 리터럴 유니언 + 가드)로 변환된다. 프레임, 호스트 승격,
`RustraCommandError` 는 이전과 바이트 단위로 동일하다.
