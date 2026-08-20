//! Streaming 예제 — Rust → JS 이벤트 푸시 (`Package::emit`).
//!
//! 장기 실행 커맨드(`startJob`)가 진행률을 `progress.tick` 이벤트로 스트리밍하고
//! 종료 시 `job.done` 을 발행한다. 호스트 어댑터는 `event_bus()` 를 폴링해
//! 플랫폼 푸시 채널로 전달한다:
//!
//! - Node (본 예제의 `apps/node-app`): `setInterval` 폴링 → `EventEmitter`
//! - Tauri: 폴링 → `app.emit()`
//!
//! `startJob` 는 즉시 반환하고 백그라운드 스레드가 이벤트를 채운다
//! (비동기 offload — invoke 호출자를 블록하지 않는다).

use rustra::Package;
use rustra::prelude::*;
use std::sync::Arc;

#[bridge_type]
pub struct StartJobInput {
    pub job_id: String,
    pub total_steps: i64,
    /// 각 스텝 사이 대기 (ms) — 데모용.
    pub step_delay_ms: i64,
}

#[bridge_type]
pub struct StartJobOutput {
    pub accepted: bool,
}

/// 백그라운드 작업이 이벤트를 발행할 패키지 핸들. FFI 진입점이 staticlib 의
/// 전역 패키지를 쓰는 구조와 동일하게, 예제에서는 `Arc` 를 공유한다.
static PACKAGE: std::sync::LazyLock<Arc<Package>> =
    std::sync::LazyLock::new(|| Arc::new(streaming_package()));

/// JS 어댑터가 접근할 이벤트 버스 — `take_pending_events()` 로 폴링한다.
pub fn event_bus() -> rustra::events::EventBus {
    PACKAGE.event_bus().clone()
}

#[command]
pub fn start_job(input: StartJobInput) -> Result<StartJobOutput> {
    let pkg = Arc::clone(&PACKAGE);
    let job_id = input.job_id.clone();
    let total = input.total_steps;
    let delay = input.step_delay_ms.max(0) as u64;

    std::thread::spawn(move || {
        for step in 0..total {
            if delay > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
            pkg.emit(
                "progress.tick",
                serde_json::json!({ "jobId": job_id, "step": step + 1, "total": total }),
            );
        }
        pkg.emit(
            "job.done",
            serde_json::json!({ "jobId": job_id, "steps": total }),
        );
    });

    Ok(StartJobOutput { accepted: true })
}

/// 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
#[bridge_type]
pub struct JobStatusInput {
    pub job_id: String,
}

#[bridge_type]
pub struct JobStatusOutput {
    pub pending_events: i64,
    pub dropped_events: i64,
}

#[command]
pub fn job_status(_input: JobStatusInput) -> Result<JobStatusOutput> {
    let bus = PACKAGE.event_bus();
    Ok(JobStatusOutput {
        pending_events: bus.pending_len() as i64,
        dropped_events: bus.dropped_count() as i64,
    })
}

pub fn streaming_package() -> Package {
    rustra::build!("examples.streaming", start_job, job_status).done()
}
