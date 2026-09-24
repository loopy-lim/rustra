# DX 감사: 에러 메시지/진단 경험 (audit-errors)

- 범위: `crates/**`, `packages/cli/**`, `packages/node/**`, `packages/bun/**`, `packages/devtools/**`, `packages/testing/**`, `packages/types/**`(런타임 코어), `scripts/check-codegen-fresh.*`, `fuzz/**`
- 방법: 소스 인용 + 실제 CLI 실행 재현(2026-02 기준 working tree). `bun`/`node` 로 실패 시나리오(설정 없음, cargo 부재, cargo compile 실패, 코덱 디코드 실패)를 직접 구동해 출력을 캡처했다.
- 전제: 코드베이스 코멘트에 과거 감사 후속(A1, A2, A6, A7, A9, B4, 감사 #3)이 다수 보인다. 이미 잘 된 지점이 많으므로 이 보고서는 **남아 있는 불편(friction/pain point)** 중심으로 기술한다.

---

## 요약 — 상위 3대 불편 포인트

1. **[상] JS 코덱 프레임 디코드 실패가 "맨몸 Error"로 전파된다** — 명령명·에러 코드·바이트 오프셋·와이어 hex·다음 행동 힌트가 전부 없다. (`packages/types/src/frame-engine-contract.ts:18-27`, 실측: `code: undefined, message: varint out of bounds`)
2. **[중] 디코드 실패 상황에서 devtools 가 와이어 레벨 단서를 하나도 남기지 않는다** — 로그에 프레임 바이트/길이/오프셋이 없어 불편 #1을 보조할 수 없다. (`packages/devtools/src/devtools-types.ts:24-32`)
3. **[중] cargo 서브커맨드가 실패해도 스피너가 "✓ done"을 찍는다** — 컴파일 실패 직후 성공 체크마크가 CI 로그에서 오해를 낳는다. (`packages/cli/src/process.ts:70-79`, 실측 재현)

---

## 1. 이미 잘 된 지점 (개선 불필요 — 근거 보존)

감사 대상 영역의 에러 처리는 전반적으로 성숙하다. 불편 항목의 상대 심각도 판단을 위해 우선 기록한다.

- **설정/스키마 파일 부재 → 재생성 힌트**: `rustra.json` ENOENT 에 `Run "rustra init <dir>"` 힌트(`packages/cli/src/config.ts:21-30`), `schema.json` ENOENT 에 cargo 프로브 재실행 힌트(`packages/cli/src/cli-generate-files.ts:73-86`), `rustra diff --old/--new` ENOENT 에 재생성 힌트(`packages/cli/src/cli-diff.ts:19-31`). 실측:
  ```
  $ rustra generate --config ./nope.json
  Error: Config file not found: /tmp/…/nope.json. Run "rustra init <dir>" to create a project, or pass the right path via --config.
  ```
- **exit 코드 계약**: usage 오류 exit 2 / 런타임 실패 exit 1, 메시지 정규식이 아닌 `UsageError` 타입 판별(`packages/cli/src/index.ts:37-44`).
- **오타 suggestion**: `Unknown command: bogus … Did you mean …`(`packages/cli/src/cli-main.ts:64-70`). 실측 확인.
- **cargo 부재 시 rustup 안내**: `cargo metadata` ENOENT 를 감지해 `Install Rust with https://rustup.rs` 힌트(`packages/cli/src/cargo-metadata.ts:23-34`). 실측 확인.
- **네이티브 미빌드 → 빌드/환경변수 힌트**: Node `No Rustra Node runtime was found. Build the inferred Cargo binary, or set RUSTRA_NODE_BINARY to its absolute path.`(`packages/node/src/node-bootstrap.ts:36-40`), Bun 동일 문구 + `RUSTRA_BUN_LIBRARY`(`packages/bun/src/bun-ffi.ts:169-174`).
- **네이티브 버전(계약 해시) 불일치 → 원인+수순 힌트 + 후보 전수 보고**: `contract hash mismatch: native="…" vs expected="…" — … regenerate the TypeScript and native codecs, rebuild the Rust archive, then rebuild the native app`(`packages/node/src/node-bootstrap.ts:83-91`). 후보 기각 시 각 후보 경로+mtime+기각 사유를 나열(`packages/node/src/node-bootstrap.ts:108-133`, `packages/bun/src/bun-ffi-library.ts:105-135`) — stale cdylib 함정(과거 감사 A1)에 대한 방어가 텍스트로도 드러난다.
- **`rustra doctor`의 fix 라인 관례**: 모든 검사 결과에 `fix:` 액션 라인(`packages/cli/src/doctor-format.ts:30-35`), `codegen.generated_freshness` PASS 에도 "런타임 바이너리는 재빌드 대상이 아니다" 한계 고지(`packages/cli/src/doctor-checks.ts:318-337`, 감사 #3 후속).
- **NDJSON 파싱 실패 라인 보존**: 자식 프로세스가 출력한 비-NDJSON 줄을 링 버퍼로 보존했다가 exit 시 대기 요청 에러에 첨부(`packages/node/src/node-ndjson-diagnostics.ts:44-97`) — 맨몸 "exited before responding" 를 예방.
- **Rust 패닉 정규화**: FFI 경로 패닉을 `internal: panic — {msg}` 단일 포맷 에러 프레임으로(`crates/rustra/src/ffi_buffer_entries.rs:34-39`).
- **fuzz/robustness**: 디코더 신뢰 경로를 무작위 바이트로 공격하는 타깃 3종(`fuzz/fuzz_targets/invoke_frame.rs`, `invoke_complex_value.rs`, `invoke_complex_serde.rs`) — 패닉 대신 Err 거부가 불변식으로 검증된다.

---

## 2. 불편 포인트 (심각도 순)

### 2.1 [상] JS 코덱 디코드 실패가 코드·명령·오프셋·힌트 없는 맨몸 Error 로 전파

- **근거(소스)**: `packages/types/src/frame-engine-contract.ts:16-27`
  ```ts
  try {
    response = codec.decode(frame);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err // ← Error 면 그대로 통과
          : new RustraCommandError('invoke.failed', `codec decode failed: ${String(err)}`),
    };
  }
  ```
  생성 코덱은 plain `Error` 를 던진다: `throw new Error('varint out of bounds')` 등(`examples/calculator/generated/frame-codecs.ts:35,40,97,139`). 따라서 `instanceof Error` 분기 때문에 래핑이 발동하지 않는다.
- **근거(실측)**:
  ```
  tier2Outcome(throwingCodec, buf) → error name: Error | code: undefined | message: varint out of bounds
  ```
- **왜 불편한가**: (1) `error.code` 로 분기하는 소비자 코드(`@rustra/types` errors.ts의 코드 계약)가 `undefined` 를 받는다 — 디코드 버그와 핸들러 실패를 구분할 수 없다. (2) 어느 명령/어느 필드에서 터졌는지 메시지에 없다(호출 지점 dispatch 는 `command` 를 알고 있는데 버린다 — `packages/types/src/frame-engine-dispatch.ts:37-43`). (3) 와이어 단서(바이트 길이, hex)도 없고, 존재하는 진단 채널인 `RUSTRA_DEBUG=1` 와이어 덤프(`packages/types/src/debug.ts:96-110`)를 에러 메시지가 안내하지 않는다. 반면 동일 계층의 JSON 경로는 `invalid json: {detail}`(`packages/types/src/json-wire.ts:80`), inspector 는 `invalid snapshot: … at byte 42`(`packages/types/src/inspector.ts:141-152`)처럼 위치 정보를 주는 데 비해 tier 2 경로만 낙후됐다.
- **제안**: `tier2Outcome` 이 command 이름을 받도록 서명을 넓혀 `RustraCommandError('invoke.malformed', "decode failed for 'addNumbers' at offset N: … — set RUSTRA_DEBUG=1 to dump wire bytes")` 로 정규화하거나, 최소한 `error.code` 를 부여할 것.

### 2.2 [중] 디코드 실패 시 devtools 의 와이어 레벨 지원 부재

- **근거(소스)**: `DevtoolsLog` 는 `command/durationMs/ok/payload/result/error{code?,message}` 만 담는다 — 프레임 바이트, 응답 길이, 디코드 오프셋 필드가 없다(`packages/devtools/src/devtools-types.ts:24-32`). `capturePayload` 기본값 off(`packages/devtools/src/devtools-types.ts:34-36`), 타임라인 HTML 은 error 를 `code: message` 한 줄로만 렌더(`packages/devtools/src/timeline-report.ts:59-70`). 패키지 export 는 계측 엔진+타임라인 2개뿐(`packages/devtools/src/index.ts:7-9`) — 원시 프레임을 오프라인으로 재해석하는 도구(예: `decodeFrameHex(schema, hex)`)가 없다.
- **왜 불편한가**: 불편 2.1 처럼 맨몸 Error 만 남는 상황에서 devtools 는 "어느 명령이 실패했는지"만 보태준다. 실패 프레임의 바이트가 로그에 남지 않으면 프로세스가 끝난 뒤 재현할 방법이 없고, 네이티브/JS 코덱 버전 어긋남 같은 wire 불일치 추적이 `RUSTRA_DEBUG` 켜고 재실행하는 수작업으로 떨어진다. 성능(타임라인/통계)은 성숙, 장애(decode failure forensics)는 공백이라는 비대칭.
- **제안**: `DevtoolsLog` 에 `frameBytesHex?(절단된 256B)`/`frameByteLength` 선택 필드 추가(tier 3 계약과 같은 additive 확장), 실패 로그 한정 수집.

### 2.3 [중] cargo 서브커맨드 실패 직후에도 "✓ … done" 스피너 출력

- **근거(소스)**: `packages/cli/src/process.ts:69-79` — `child.on('exit')` 에서 코드 판정 **전에** `✓ ${progressLabel} done in ${total}s` 을 출력한 뒤 reject 한다.
- **근거(실측)**: 가짜 cargo(`run` 시 exit 101)로 재현:
  ```
  [rustra] ⠋ Rust schema generation (dx-audit/generate)...
  compile error: simulated failure
  [rustra] ✓ Rust schema generation (dx-audit/generate) done in 0.0s
  Error: Rust schema generation failed for dx-audit/generate (/…/Cargo.toml): cargo exit 101
  ```
- **왜 불편한가**: 실패 신호(✓)와 최종 에러 사이에 성공 표기가 끼어 CI 로그 스크롤에서 "빌드 됐는데 다른 게 죽었다"로 오독하기 쉽다. 소요시간 표기 자체는 유용하므로 실패 시 `✗ … failed in Xs` 로 바꾸는 수준의 소형 수정으로 해결된다.
- **제안**: `exit` 핸들러에서 `code === 0` 일 때만 ✓ 를 출력, 그 외엔 ✗/failed 표기.

### 2.4 [중] `Generated drift` 9종 중 7종에 "다음 행동" 힌트가 없다

- **근거(소스)**: `packages/cli/src/manifest.ts:49-106` — 힌트 있음: `(missing): … Run rustra codegen first.`(L49), `cli-generate-files.ts:158` `(obsolete): … Run rustra codegen.` 힌트 없음: `(invalid manifest)`(L59), `(schema changed)`(L65), `(generator changed)`(L72), `(missing manifest entry)`(L87), `(disk changed)`(L99), `(manifest stale)`(L101), `(unexpected)`(L106).
- **왜 불편한가**: 이 에러의 1차 소비자는 CI 이고, 로그만 보는 기여자에게는 `Run rustra codegen --config rustra.json` 한 줄이 있고 없고가 복구 시간을 좌우한다. 같은 저장소의 doctor 는 모든 검사에 `fix:` 를 붙이는 관례(`doctor-format.ts:30-35`)와 정합하지 않다. 특히 `(generator changed)` 는 CLI 버전업 후 재생성이 정답이라 힌트가 거의 필수다.
- **제안**: 9종 전부에 공통 접미 힌트 `Run rustra codegen --config rustra.json` 부착(1줄 상수).

### 2.5 [하] `cargo run` 실패 래퍼 메시지에 힌트 없음 + 드문 ENOENT 누출

- **근거(소스)**: `packages/cli/src/cli-codegen.ts:151-159` — `Rust schema generation failed for {pkg}/{bin} ({manifest}): cargo exit 101`. 컨텍스트는 좋지만 위의 컴파일 에러를 보라는 안내나 `rustra doctor` 안내가 없다. `spawnInherit` 의 `error` 이벤트 경로는 raw Node 에러(`spawn cargo ENOENT`)를 그대로 reject(`packages/cli/src/process.ts:60-63`) — `cargo metadata` 쪽(`cargo-metadata.ts:30-32`)과 달리 rustup 힌트가 없다. 실측에서도 최종 메시지는 `…: cargo exit 101` 로 끝나 "무엇을 하라"는 문장이 없다.
- **왜 불편한가**: 신규 사용자의 1회차 실패 지점이 정확히 이 경로(cargo 미설치/툴체인 불완전)인데, 힌트 품질이 metadata 경로와 비대칭이다(초보자가 codegen 진입 전 반드시 통과하는 metadata 검사 때문에 실제 노출 빈도는 낮다 → 하).
- **제안**: wrapError 문구에 `(compile errors are printed above; run "rustra doctor" to check the toolchain)` 추가, `spawnInherit` error 이벤트에서 ENOENT 인 경우 rustup 힌트 재사용.

### 2.6 [하] contract.mismatch 메시지가 해시를 16자로 절단

- **근거(소스)**: `packages/node/src/node-bootstrap.ts:85` — `native="${nativeHash.slice(0, 16)}… vs expected="${expectedHash.slice(0, 16)}…"`. Bun 엔진 코어도 동일 포맷(`packages/types/src/frame-engine-contract.ts` 계약 handshake). full hash 를 주지 않아 schema.json 의 `contract.ts` 상수와 수작업 대조가 불가능하다 — "같은가 다른가"는 알지만 "어느 쪽이 옛것인지" 추적하려면 재실행/디버거가 필요하다.
- **왜 불편한가**: 힌트(재생성/재빌드 수순)는 훌륭하지만, 후보가 여럿인 환경(2.4 감사 A1 의 stale cdylib 시나리오)에서는 full hash 대조가 다음 액션 결정에 필요하다. 다만 후보 나열+mtime 보고가 이미 병행되므로 하.
- **제안**: 메시지에 full hash 추가(또는 `--verbose` 시), 잘림은 표시용으로만.

### 2.7 [하] `parsePackageSchema` 라이브러리 소비 경로에 파일 컨텍스트 없음

- **근거(소스)**: `packages/cli/src/schema-validation.ts:84-87` — `Invalid schema: missing or invalid "packageId"` 는 경로/파일명 없음. CLI 내부에서는 `cli-generate-files.ts:88-97`, `cli-diff.ts:34-44` 가 경로+cargo run 힌트로 감싸지만, `@rustra/cli` 패키지 export(`packages/cli/src/index.ts:15`)로 직접 쓰는 프로그래밍 소비자(커스텀 파이프라인)는 날 메시지를 받는다.
- **왜 불편한가**: 라이브러리 호출자는 어떤 파일이 잘못됐는지 자체 컨텍스트로 재조립해야 한다. CLI 유저에게는 이미 불문명 → 하.

---

## 3. 정량 스냅샷 (참고)

- 감사 대상 TS 패키지(cli/node/bun/types/devtools/testing)의 `new Error|new RustraCommandError|new UsageError` 생성점 총 260곳. 휴리스틱(생성점 8줄 이내 재실행/설정/설치 키워드)으로는 약 31%(81곳)만 명시적 힌트 보유. 단, 나머지 다수는 내부 불변식·래퍼(cause 보존 후 상위에서 컨텍스트 부여)라 실제 사용자 대면 힌트율은 이보다 높다 — 위 항목별 소스 인용이 정확한 근거다.
- 실측 재현 목록: 설정 없음(exit 1, 힌트 있음), 미지 명령(exit 2, suggestion), cargo metadata 부재(rustup 힌트), cargo compile 실패(exit 1, 컨텍스트 있음/✓ 오표기), 코덱 디코드 실패(plain Error, code undefined).

## 4. 권고 우선순위

| 순위 | 항목                                                                                                       | 심각도 | 예상 공수 |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------ | --------- |
| 1    | 2.1 tier2 디코드 실패의 `RustraCommandError('invoke.malformed')` 정규화 + command/오프셋/RUSTRA_DEBUG 힌트 | 상     | 중        |
| 2    | 2.3 스피너 실패 시 ✓→✗                                                                                     | 중     | 소        |
| 3    | 2.4 `Generated drift` 전 변형에 재생성 힌트                                                                | 중     | 소        |
| 4    | 2.2 DevtoolsLog 실패 프레임 hex(선택 필드) + 오프라인 디코드 헬퍼                                          | 중     | 중        |
| 5    | 2.5 cargo run 실패 힌트 보강 / 2.6 full hash / 2.7 라이브러리 경로 컨텍스트                                | 하     | 소        |
