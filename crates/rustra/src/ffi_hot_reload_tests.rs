use super::*;
use crate::Package;

// ── rustra_ffi_hot_reload (A2, experimental) ────────────────
//
// 코어 로직(run_hot_reload)은 로컬 패키지로 결정적으로 검증하고, FFI 심볌은
// 전역 컨텍스트를 공유하므로(FFI_CONTEXT OnceLock first-wins) 심볌 경로만
// SINK_TEST_MUTEX 와 같은 패턴의 상호배제 락으로 검증한다.

/// 핫 리로드 대상 로컬 패키지 — 전역 컨텍스트를 건드리지 않는다.
fn local_package() -> Package {
    Package::builder("test.hot")
        .command("echo", |args: serde_json::Value| {
            Ok::<_, crate::RustraError>(args)
        })
        .build()
}

fn blob(entries: &[(&str, &str)]) -> Vec<u8> {
    let list: Vec<(String, String)> = entries
        .iter()
        .map(|(name, hash)| ((*name).to_string(), (*hash).to_string()))
        .collect();
    postcard::to_allocvec(&list).unwrap()
}

fn command_id_of(pkg: &Package, name: &str) -> u16 {
    pkg.state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .get(name)
        .expect("command exists")
        .command_id
}

fn signature_of(pkg: &Package, name: &str) -> String {
    let command = pkg
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .get(name)
        .expect("command exists")
        .clone();
    command_wire_signature(name, &command)
}

// ── 코어: 적용 경로 — replace() 의미론 ──────────────────────

#[test]
#[cfg(debug_assertions)]
fn hot_reload_applies_matching_entry_with_replace_semantics() {
    let pkg = local_package();
    let id_before = command_id_of(&pkg, "echo");
    let generation_before = pkg.schema_generation();
    // 캐시를 미리 채운다 — 무효화되지 않으면 아래 live_schema 재조회가
    // 낡은 세대를 돌려주어 이 테스트가 실패한다(재계산 계약의 민감한 검증).
    let stale_live = pkg.live_schema();
    assert_eq!(
        stale_live["schemaGeneration"].as_u64(),
        Some(generation_before)
    );

    let report = run_hot_reload(Some(&pkg), &blob(&[("echo", &signature_of(&pkg, "echo"))]));

    assert!(report.ok, "matching entry must apply: {:?}", report.error);
    assert_eq!(report.applied, Some(1));
    assert!(report.skipped.is_empty(), "no entry may be skipped");
    assert!(
        pkg.schema_generation() > generation_before,
        "replace() 의미론 — 적용 시 세대가 진행한다"
    );
    // live_schema 재계산: 캐시 무효화 → 재조회 시 새 세대가 심긴다.
    let live = pkg.live_schema();
    assert_eq!(
        live["schemaGeneration"].as_u64(),
        Some(pkg.schema_generation()),
        "in-flight context must observe the recomputed live schema"
    );
    // command_id 보존 — replace 경로의 핵심 불변식.
    assert_eq!(command_id_of(&pkg, "echo"), id_before);
    // 리포트 세대 스냅샷이 최종 세대와 일치한다.
    assert_eq!(report.schema_generation, Some(pkg.schema_generation()));
}

#[test]
#[cfg(debug_assertions)]
fn hot_reload_report_json_uses_camel_case_wire_keys() {
    let pkg = local_package();
    let report = run_hot_reload(Some(&pkg), &blob(&[("echo", &signature_of(&pkg, "echo"))]));
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["ok"], serde_json::Value::Bool(true));
    assert!(json.get("applied").is_some());
    assert!(json.get("schemaGeneration").is_some(), "camelCase wire key");
    assert!(json.get("skipped").is_some());
}

// ── 코어: loud 스킵 — 조용한 스킵이 아니라 리포트에 남는다 ───

#[test]
#[cfg(debug_assertions)]
fn hot_reload_skips_signature_mismatch_loudly() {
    let pkg = local_package();
    let generation_before = pkg.schema_generation();
    let wrong_hash = "0".repeat(64);

    let report = run_hot_reload(Some(&pkg), &blob(&[("echo", &wrong_hash)]));

    assert!(report.ok, "skip is not a call failure — it is reported");
    assert_eq!(report.applied, Some(0), "mismatched entry must not apply");
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].name, "echo");
    assert_eq!(report.skipped[0].reason, "signature.mismatch");
    assert_eq!(
        report.skipped[0].actual.as_deref(),
        Some(signature_of(&pkg, "echo").as_str()),
        "actual wire signature must be reported so the host sees why"
    );
    assert_eq!(
        pkg.schema_generation(),
        generation_before,
        "skipped entries must not mutate the registry"
    );
}

#[test]
#[cfg(debug_assertions)]
fn hot_reload_skips_unknown_names_loudly() {
    let pkg = local_package();
    let report = run_hot_reload(Some(&pkg), &blob(&[("ghost", &signature_of(&pkg, "echo"))]));

    assert!(report.ok);
    assert_eq!(report.applied, Some(0));
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].name, "ghost");
    assert_eq!(
        report.skipped[0].reason, "command.not_found",
        "reason joins the existing error-code ladder"
    );
    assert!(report.skipped[0].actual.is_none());
}

#[test]
#[cfg(debug_assertions)]
fn hot_reload_reports_applied_and_skipped_together() {
    let pkg = local_package();
    let good = signature_of(&pkg, "echo");
    let report = run_hot_reload(
        Some(&pkg),
        &blob(&[("echo", &good), ("ghost", &good), ("echo", &"f".repeat(64))]),
    );

    assert_eq!(report.applied, Some(1));
    assert_eq!(report.skipped.len(), 2);
    assert_eq!(report.skipped[0].reason, "command.not_found");
    assert_eq!(report.skipped[1].reason, "signature.mismatch");
}

// ── 코어: 에러 사다리 ───────────────────────────────────────

#[test]
fn hot_reload_rejects_frozen_registry() {
    let pkg = local_package();
    let blob_bytes = blob(&[("echo", &signature_of(&pkg, "echo"))]);
    pkg.freeze();

    let report = run_hot_reload(Some(&pkg), &blob_bytes);

    assert!(!report.ok, "frozen registry must reject the reload");
    let error = report.error.as_deref().expect("error carries the code");
    assert!(
        error.starts_with("registry.frozen"),
        "existing error code must be reused, got: {error}"
    );
    assert_eq!(report.applied, None);
    assert_eq!(report.schema_generation, None);
}

/// release 프로파일 대응 — release `build()` 패키지는 태어날 때부터 동결
/// (`builder_build.rs`: `!cfg!(debug_assertions)`)이므로 주입이 거부된다.
/// debug의 `hot_reload_rejects_frozen_registry`(명시적 freeze)와 짝을 이루어
/// 동결 거부 경로가 양쪽 프로파일에서 모두 고정된다.
#[test]
#[cfg(not(debug_assertions))]
fn hot_reload_rejects_a_release_frozen_package() {
    let pkg = local_package();
    assert!(pkg.is_frozen(), "release build() freezes the package");
    let blob_bytes = blob(&[("echo", &signature_of(&pkg, "echo"))]);

    let report = run_hot_reload(Some(&pkg), &blob_bytes);

    assert!(!report.ok, "frozen registry must reject the reload");
    let error = report.error.as_deref().expect("error carries the code");
    assert!(error.starts_with("registry.frozen"), "got: {error}");
    assert_eq!(report.applied, None);
    assert_eq!(report.schema_generation, None);
}

#[test]
#[cfg(debug_assertions)]
fn hot_reload_double_apply_of_the_same_name_applies_twice() {
    // 같은 이름의 중복 항목도 각각 독립 판정한다 — 첫 항목 적용 후에도 라이브
    // 서명은 같은 와이어 계약을 유지하므로(replace는 스키마 불변) 두 번째도
    // 적용된다. benign 하고 문서화된 동작: applied: 2, 세대는 두 번 진행.
    let pkg = local_package();
    let generation_before = pkg.schema_generation();
    let good = signature_of(&pkg, "echo");

    let report = run_hot_reload(Some(&pkg), &blob(&[("echo", &good), ("echo", &good)]));

    assert!(report.ok);
    assert_eq!(report.applied, Some(2));
    assert!(report.skipped.is_empty());
    let generation_after = pkg.schema_generation();
    assert!(
        generation_after >= generation_before + 2,
        "each apply advances the generation"
    );
}

#[test]
fn hot_reload_reports_unregistered_engine() {
    let report = run_hot_reload(None, &blob(&[("echo", "0")]));
    assert!(!report.ok);
    let error = report.error.as_deref().expect("error carries the code");
    assert!(
        error.starts_with("ffi.not_registered"),
        "same code string as the other FFI entries, got: {error}"
    );
}

#[test]
#[cfg(debug_assertions)]
fn hot_reload_reports_malformed_blob_as_invalid_args() {
    let pkg = local_package();
    let report = run_hot_reload(Some(&pkg), &[0xff, 0x01, 0x02]);
    assert!(!report.ok);
    let error = report.error.as_deref().expect("error carries the code");
    assert!(
        error.starts_with("command.invalid_args"),
        "host-authored blob decode failure is loud, got: {error}"
    );
}

#[test]
#[cfg(debug_assertions)]
fn hot_reload_accepts_an_explicitly_empty_manifest() {
    // 빈 목록도 유효한 blob 이다 — postcard 로는 길이 0 varint 한 바이트.
    let pkg = local_package();
    let report = run_hot_reload(Some(&pkg), &blob(&[]));
    assert!(report.ok);
    assert_eq!(report.applied, Some(0));
    assert!(report.skipped.is_empty());
}

// ── 코어: 서명 해시 정의 ────────────────────────────────────

#[test]
fn wire_signature_is_sha256_hex_of_the_schema_entry() {
    let pkg = local_package();
    let sig = signature_of(&pkg, "echo");
    assert_eq!(sig.len(), 64, "sha-256 hex");
    assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
    // 정의 고정 — 계약 해시와 동일한 해시 함수에 항목 JSON 원본 바이트를 넣는다.
    let entry = crate::package_codegen::command_schema_entry(
        "echo",
        &pkg.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commands["echo"],
    );
    assert_eq!(
        sig,
        crate::contract_hash(serde_json::to_vec(&entry).unwrap())
    );
    // 안정성 — 같은 상태면 같은 서명.
    assert_eq!(sig, signature_of(&pkg, "echo"));
}

#[test]
fn wire_signature_changes_when_the_command_schema_changes() {
    // 서명이 와이어 스키마에 묶여 있는지 — 같은 이름이라도 입출력 형태가
    // 다르면 서명이 다르다. (Value→Value 두 클로저는 와이어 계약이 같으므로
    // 같은 서명을 가진다 — 그것이 이 표면의 요구사항이다: 와이어가 같으면
    // 핸들러 교체는 항상 합법이다.)
    #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    struct WideOutput {
        value: i64,
    }
    let wide = Package::builder("test.hot.sig")
        .command("same", |_args: serde_json::Value| {
            Ok::<WideOutput, crate::RustraError>(WideOutput { value: 1 })
        })
        .build();
    let v1 = Package::builder("test.hot.sig")
        .command("same", |args: serde_json::Value| {
            Ok::<_, crate::RustraError>(args)
        })
        .build();
    assert_ne!(
        signature_of(&v1, "same"),
        signature_of(&wide, "same"),
        "output schema change must invalidate the wire signature"
    );
}

// ── 심볌: 전역 컨텍스트 경로 (상호배제) ─────────────────────

/// 전역 FFI_CONTEXT 를 공유하는 테스트 간 상호배제 — apply 경로가 설치된
/// 패키지의 세대를 진행시키므로 직렬화한다 (SINK_TEST_MUTEX 패턴).
static HOT_RELOAD_TEST_MUTEX: Mutex<()> = Mutex::new(());

fn symbol_report(blob_bytes: &[u8]) -> serde_json::Value {
    let mut out_len = 0usize;
    let ptr = unsafe { rustra_ffi_hot_reload(blob_bytes.as_ptr(), blob_bytes.len(), &mut out_len) };
    assert!(!ptr.is_null(), "valid ABI must return a report buffer");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { rustra_ffi_free(ptr, out_len) };
    serde_json::from_slice(&bytes).expect("report is JSON")
}

#[test]
#[cfg(debug_assertions)]
fn ffi_hot_reload_symbol_dispatches_to_the_installed_package() {
    let _guard = HOT_RELOAD_TEST_MUTEX.lock().unwrap();
    // 전역 FFI_CONTEXT 는 OnceLock first-wins 이므로 "내" 패키지를 설치하지
    // 않는다 — 이미 설치된 것(ffi_tests.rs 의 test.ffi 또는 먼저 실행된 다른
    // 테스트의 패키지)을 그대로 쓴다. 어느 패키지가 이겼든 심볼 계약("설치된
    // 패키지의 기존 명령에 대해 리포트")은 동일하다. 설치가 없으면 등록한다.
    let installed = get_package().cloned().unwrap_or_else(|| {
        let candidate = Package::builder("test.ffi")
            .command("addNumbers", |args: serde_json::Value| {
                let a = args["a"].as_i64().unwrap_or(0);
                let b = args["b"].as_i64().unwrap_or(0);
                Ok::<_, crate::RustraError>(serde_json::json!(a + b))
            })
            .build();
        candidate.register_ffi();
        get_package().expect("package must be registered").clone()
    });
    let name = installed
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .commands
        .keys()
        .next()
        .expect("installed package has commands")
        .clone();
    let sig = signature_of(&installed, &name);
    let generation_before = installed.schema_generation();

    let json = symbol_report(&blob(&[(&name, &sig)]));
    assert_eq!(json["ok"], serde_json::Value::Bool(true));
    assert_eq!(json["applied"], 1);
    let generation_after = installed.schema_generation();
    assert!(
        generation_after > generation_before,
        "symbol path advances the generation on the installed package"
    );

    // 심볌 경로의 loud 스킵 — 존재하지 않는 이름은 리포트에 남는다.
    let json = symbol_report(&blob(&[("definitely_missing_cmd", &sig)]));
    assert_eq!(json["ok"], serde_json::Value::Bool(true));
    assert_eq!(json["applied"], 0);
    assert_eq!(json["skipped"][0]["reason"], "command.not_found");
    assert_eq!(json["skipped"][0]["name"], "definitely_missing_cmd");
}

#[test]
fn ffi_hot_reload_null_arguments_return_null() {
    let payload = [0u8; 1];
    let mut out_len = 0usize;
    let ptr = unsafe { rustra_ffi_hot_reload(std::ptr::null(), 4, &mut out_len) };
    assert!(ptr.is_null(), "null blob with non-zero len is ABI misuse");
    let ptr = unsafe { rustra_ffi_hot_reload(payload.as_ptr(), 1, std::ptr::null_mut()) };
    assert!(ptr.is_null(), "null out_len is ABI misuse");
}
