# 2026-10-03 DX 최종 커밋 후보 검증

세 차례 DX·온보딩 개선과 최종 독립 검토를 마무리했다. 기존 실험 변경을 제외한
후보를 별도 디렉터리에 내보내 의존성을 설치하고 로컬 검사를 진행했다.

## 마지막 수정

- Cargo 실패 시 성공 표시가 먼저 나오는 문제를 고쳤다. 실제 실패 프로세스 회귀를 RED → GREEN으로 확인했다.
- Node/Bun의 Cargo 출력 경로에 `#`, `%`, `?`가 있어도 런타임 URL을 올바르게 계산한다. 실제 Cargo metadata 회귀를 RED → GREEN으로 확인했다.
- 새 checkout의 Node 테스트가 필요한 Rust 실행 파일을 먼저 빌드하도록 했다.
- 이벤트 entry의 불필요한 마지막 빈 줄을 생성기에서 제거하고 소유한 생성물을 재생성했다.

## 검증 결과

| 검사                    | 결과                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| 격리 후보 CLI           | Node 474 + Bun 45 = 519개, 실패 0                                           |
| 호스트 패키지           | native Node 92, Bun 65, Tauri JS 68, RN JS 89 통과                          |
| 공유 types              | 311개 통과                                                                  |
| 생성물                  | 표준 예제 6개와 UniFFI bindings 1개 freshness 통과                          |
| 실제 호출               | Node·CRUD·Bun runtime 및 온보딩 생성/호출/타입 변경/재생성/재빌드/호출 통과 |
| RN 배포 자산            | 실제 tarball의 native 자산과 packed consumer 통과                           |
| 정적 검사               | build, API snapshot, architecture, release coherence, lint/format 통과      |
| 문서/도구               | 문서 37개, release tools 86개, registry fixtures 39개 통과                  |
| 의존성                  | 알려진 취약점 0; 전체 lint의 기존 경고 7개 유지                             |
| 기존 작업 트리 Rust     | workspace 596개 통과, Tauri doctest 순차 재검사 통과                        |
| 기존 작업 트리 hot-core | 443개 통과                                                                  |

최초 기존 작업 트리 검사는 Cargo 캐시 쓰기 권한으로 bindings 단계에서 멈췄다.
권한 적용 후 해당 단계부터 나머지 검사를 모두 통과했다. 동시 Cargo 빌드 중 발생한
Tauri doctest의 rlib 누락은 경합이 끝난 뒤 순차 재검사로 해소됐다.

격리 후보의 첫 Node 검사는 실행 파일 부재로 실패했다. 테스트 스크립트에 native
빌드를 추가한 뒤 실패 단계부터 모든 잔여 검사를 통과했다. 마지막 생성기 공백 정리
후에는 CLI를 다시 빌드하고 실제 호스트 entry 테스트 4개, 코드젠 검사와 API 검사를
다시 통과했다. 필요 native 산출물이 없는 검사와 Bun 호환성 검사의 명시적 skip은
통과 수에 포함하지 않았다.

## 커밋 범위와 소스 식별

런타임·CLI·필수 A2 factory/E1 FFI와 native fixture·생성물·문서가 서로 의존하므로
하나의 일관된 커밋 후보로 묶었다. RN 실험 workspace/lock 변경, 과거 성능 문서와
영수증 등 기존 53개 경로는 작업 트리에 보존했다. `package.json`의 RN 실험 스크립트도
스테이징에서 제외했다. 이 경계를 반영한 197개 스테이징 파일은 검증한 export와
바이트 단위로 일치했다. 이 최종 기록은 그 뒤 추가했다.

- 기준 HEAD: `58e1835e5f2b74f9a8c1e21addabcf85836534cd`
- 후보 소스 파일: 1045개
- 후보 소스 SHA-256: `0a68f5ae6a349ae37fbb7eecfc507c1e35341b6fdbabd334c5330ac23fee8290`
- 해시: index의 crates/packages/examples/scripts와 루트 빌드 manifest 소스에서 정렬한 `상대경로:파일SHA256` 행을 newline으로 연결해 SHA-256을 계산했다. cjs를 포함하고 문서·빌드 산출물은 제외했다.

## 증거의 경계

이 기록은 로컬 후보 검증이다. GitHub CI, npm/crates 발행 또는 실기기 승인 결과를
의미하지 않는다. 새 RN 플랫폼 준비의 실제 SDK/기기 실행과 성능 A/B, 기존 ASan
시작 전 교착 문제는 완료로 표시하지 않는다. 이전 RN Hermes 1,412 assertion 결과는
동일한 native 소스 입력 해시의 기존 실행 증거로 유지했다.

이전 영수증의 `sourceFiles`는 실행 당시 스냅샷을 그대로 보존했다. 문서 형식 정리와
changeset 설명 보강으로 바뀐 문서·연결 영수증 해시만 현재 파일에 맞췄다. 중첩된
`init --setup` 기록의 공유 target 바이너리는 후속 빌드로 교체됐으므로 그 해시는
역사적 실행 artifact 식별자다. 현재 바이너리 일치 증거로 사용하지 않는다.

## 로그 식별

실패 원인과 순차 복구를 포함한 로그 SHA-256이다. 로그 경로는 이 로컬 실행의
위치이며 원격 checkout에 로그 자체를 포함하지 않는다.

| 로그                                         | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/rustra-final-local.log`                | `c42d9c0adc1443a925ae028f82fb82ff0e1dc93c2370750e235bff2119e906c6` |
| `/tmp/rustra-final-local-remainder.log`      | `ed2f34dbbb481b961876f8363a155ebed009c35b08f6e47ff0e2e723e3ae6a52` |
| `/tmp/rustra-final-local-remainder-docs.log` | `9959addb1b8f5e0ef79cdd16554e5062779dcc78d32c9ff838ed9738f359ecc5` |
| `/tmp/rustra-final-clippy.log`               | `026edc6faa6ddd6911c3bb089a5dd9aa2ce77ee6cf748d7babc08054e417bdce` |
| `/tmp/rustra-final-rust.log`                 | `8a541427244479ee4960afeb532af76d88cbb7ca0ca9856f849685e25d3db52e` |
| `/tmp/rustra-final-tauri-doc.log`            | `ee7a21d55186d779c6ca85445effea66b6500b7636441132ba5b45937a99610b` |
| `/tmp/rustra-final-hot-core.log`             | `5fff753c088679cf91b15b6e2edad1f1fc50cdaeb70d297fc120dbb655e91632` |
| `/tmp/rustra-final-scoped-tests.log`         | `bb1591a7f7f331479ca470b6a9a55cf1afd082999c09bbe6f033f8939bd9726f` |
| `/tmp/rustra-final-candidate-local.log`      | `0afee1445615b5eea27b213cd90f1d3db6833512d772291364a85ffdd5244143` |
| `/tmp/rustra-final-candidate-remainder.log`  | `649cdc20334e922e277dc04193cdb545861b8bd3a355dfa646ed326e16cf66a8` |
| `/tmp/rustra-final-candidate-rn-package.log` | `416480ca1d444e4b71f1cad98129a2724d8f938b86d618d2a1b076f6024ce321` |
| `/tmp/rustra-final-candidate-style.log`      | `b49de4f40fb262b4d0344f430a344cf75eb86d708934c5d53d185e0d8f07ebbe` |
