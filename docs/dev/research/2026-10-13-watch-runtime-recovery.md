# 2026-10-13 dev 런타임 갱신과 실패 복구

이 후속 작업은 앞선 DX 기록의 미측정 항목인 watch 변경 감지와 컴파일 실패 복구를
실제 Node·Bun 소비 경로에서 검증한다. `source-injected` 로컬 여정이며 발행·원격 CI·
실기기 승인과 구분한다.

## 재현한 결함

첫 재현에서는 Rust 구현의 문자열 반환만 대문자로 바꾸었다. `rustra dev`는
`regenerated`와 reload를 알렸지만 실제 호출은 계속 소문자를 반환했다. schema
generator만 빌드하고 invoke 바이너리/cdylib를 재빌드하지 않아 생긴 문제다. 구현만
바뀌면 계약 hash가 같아서 strict 계약 검증으로도 오래된 구현을 구분할 수 없다.

Node·Bun 설정의 Cargo producer를 watch 입력에 포함하고, codegen 뒤 실제 런타임
빌드가 성공해야 reload를 알리도록 수정했다. schema crate와 runtime crate가 다른
설정도 포함한다. 기존 wasm·gated dylib 경로의 발행·거부 정책은 유지한다.

두 번째 재현은 실패 뒤 소스를 **직전 성공과 완전히 동일하게** 되돌리는 경우다.
generator가 새 계약을 발행한 다음 `main.rs` 컴파일이 실패하면, 이전 성공 지문과
새 `lastGeneratedSchema`가 함께 남았다. 코드를 되돌릴 때 지문이 일치해 Cargo를
생략하고 잘못된 계약으로 reload하여 실제 `contract.mismatch`가 발생했다.

전체 파이프라인을 시작할 때 성공 지문을 무효화하고 모든 단계가 통과한 뒤에만
다시 저장한다. 컴파일 실패뿐 아니라 parity gate의 조기 거부에도 적용된다.
실패한 빌드는 마지막 성공 런타임 파일을 유지하지만 호스트에 reload를 알리지 않는다.
생성 계약은 이미 바뀔 수 있으므로 실패 중의 산출물 전체가 원자적으로 유지된다고
주장하지 않는다. 정확한 원상 복구도 재생성을 거쳐 계약과 런타임을 다시 맞춘다.

별도로 Bun의 `file:` 설치가 dist 내부 파일을 symlink로 만드는 것을 확인했다.
온보딩 provenance 함수가 이를 누락해 실제 성공한 설치를 `built JavaScript is missing`
으로 판정했다. 빌드된 JS/JSON 파일의 링크를 따라 실제 바이트를 hash하도록 수정하고
연결된 파일 내용 변경이 digest를 바꾸는 검사를 추가했다.

## 자동 실행

```bash
bun run --cwd packages/cli build
CARGO_NET_OFFLINE=true node scripts/onboarding-watch.mjs --host node \
  --output /tmp/watch-node.json
CARGO_NET_OFFLINE=true node scripts/onboarding-watch.mjs --host bun \
  --output /tmp/watch-bun.json
```

각 실행은 새 `init` 프로젝트와 Cargo target을 만들고 실제 Bun 설치·첫 Rust 호출을
수행한다. 이후 watcher를 실행하여 다음 순서로 검증한다.

1. 계약 hash가 같은 구현 변경을 감지하고 새 native 산출물의 대문자 결과를 호출한다.
2. 실제 `compile_error!`로 실패시킨다. Node는 계약 변경 후 실행 바이너리만 실패시켜
   생성 계약의 부분 갱신도 확인한다. 실패 진단 뒤 700ms 동안 reload 0회와 마지막
   성공 native hash 보존을 확인한다.
3. 정확히 이전 성공 소스로 복구하고 다시 호출한다. 임의의 세 번째 수정으로 지문
   결함을 가리지 않는다.
4. 계약에 `repeat` 필드를 추가하고 새 계약·native hash 및 실제 반환 `repeat:3`을
   확인한다. `rustra.json`과 package scripts를 포함한 manifest hash는 보존한다.

receipt는 edit→watch run 시작, run 시작→호출, edit→호출, 실패 감지, repair→호출을
단조 시계로 기록한다. 첫 구간에는 100ms polling과 300ms debounce가 포함된다.
호출마다 새 Bun 프로세스를 실행하므로 이미 열린 JS 엔진의 hot reload 지연은 아니다.
failure→recovered call에는 의도적인 700ms 무호출 관찰 구간이 포함된다.
native/contract/source/config/manifest hash, CLI dist hash, 소스 전후 hash와 사건 목록을
함께 남기며, 원본 compiler 출력은 실행 로그에 보존한다.

## 검증 증거

최종 결과와 원본은
[`docs/verification/evidence/2026-10-13-watch-recovery/`](../../verification/evidence/2026-10-13-watch-recovery/)
에 보존한다. 두 개의 수정 전 실제 실패 로그와 최종 Node·Bun 성공 receipt를 구분한다.
독립 runtime producer 검사에는 mock Cargo를 사용하며, 위 실제 컴파일 실행과 별도다.
POSIX 실행 파일 shim을 사용하는 해당 fixture만 Windows에서 명시적으로 제외한다.
SDK 다운로드·신규 사용자 5명 관찰·RN native 계측은 이 검사의 범위가 아니다.

최종 실제 실행:

| 항목                          |   Node host |    Bun host |
| ----------------------------- | ----------: | ----------: |
| 구현 편집→호출                |     1.003초 |     1.140초 |
| 실패 감지                     |     0.958초 |     0.534초 |
| 정확한 원상 복구→호출         |     1.115초 |     1.100초 |
| 다음 계약 변경→호출           |     1.205초 |     1.311초 |
| 실패 중 reload                |         0회 |         0회 |
| sourceStable / producerStable | true / true | true / true |

이 값은 설치된 도구와 Cargo offline cache를 사용한 단일 기능 검증의 경과 시간이다.
Node 실행은 독립 CLI 검사와 일부 겹쳤으므로 host 속도 비교나 성능 개선율로
해석하지 않는다. 원본 sample이 없는 p50/p95도 만들지 않는다.

최종 `CARGO_NET_OFFLINE=true bun run --cwd packages/cli test`는 Node test 509개와
Bun test 45개, 총 **554 passed / 0 failed**다. 분리된 온보딩 helper는 **26 passed**다.
여기에는 서로 다른 Cargo producer의 Node/Bun runtime 재빌드·실패·정확한 복귀,
parity 거부 후 최초 소스 복귀의 재생성, 기존 gated live artifact 보존 검사가 포함된다.
TypeScript build, 변경 범위 ESLint/Prettier, `git diff --check`도 통과했다.

최종 순차 Cargo 실행은 Promise chain으로 유지하며 Doctor 규칙을 끄지 않았다.
그 최종 코드로 위 두 실제 여정과 CLI 검사를 다시 통과했다. 소스만 복사한 5.7MiB
후보의 React Doctor 0.9.12는 **597파일, 100/100, 경고 0**이다. 기존 사용자 소유
calculator untracked benchmark 2개와 ignored 산출물은 이전과 같이 후보에서만
제외하고 원본은 보존했다. snapshot의 파일별 hash가 검사 범위다.
