//! Auth 예제 — 세션/토큰 관리 + Runtime Authority(capability) 게이트.
//!
//! 패턴:
//! - `signIn` 은 (데모용) 자격 증명을 검증하고 세션 토큰을 발급한다.
//! - `grant` 로 세션이 capability 를 획득하면, 그 capability 를 요구하는
//!   커맨드(`adminStats` 등)가 실행 가능해진다 — deny-by-default.
//! - capability 없이 호출하면 핸들러가 아예 실행되지 않고 `capability.denied`.
//!
//! 실서비스에서는 토큰 검증을 JSI/FFI 주입 콜백(모바일 브리지 패턴)이나
//! 백엔드 조회로 대체한다. 여기서는 의존성 없는 데모 해시 기반.

use rustra::prelude::*;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[bridge_type]
pub struct SignInInput {
    pub username: String,
    pub password: String,
}

#[bridge_type]
pub struct SignInOutput {
    pub token: String,
    /// 발급된 세션이 가진 초기 role — "admin" 이면 adminStats 요청 가능.
    pub role: String,
}

#[bridge_type]
pub struct SignOutInput {
    pub token: String,
}

#[bridge_type]
pub struct SignOutOutput {
    pub signed_out: bool,
}

#[bridge_type]
pub struct GrantInput {
    pub token: String,
    pub capability: String,
}

#[bridge_type]
pub struct GrantOutput {
    pub granted: bool,
}

#[bridge_type]
pub struct AdminStatsInput {
    pub token: String,
}

#[bridge_type]
pub struct AdminStatsOutput {
    pub sessions: i64,
    pub uptime_ms: i64,
    /// 활성 세션 사용자명 목록 — admin 가시성 예시.
    pub active_users: Vec<String>,
}

#[derive(Debug, Clone)]
struct Session {
    username: String,
    role: String,
    granted: Vec<String>,
}

static SESSIONS: std::sync::LazyLock<Mutex<BTreeMap<String, Session>>> =
    std::sync::LazyLock::new(|| Mutex::new(BTreeMap::new()));

static STARTED_AT: std::sync::LazyLock<u128> = std::sync::LazyLock::new(|| {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
});

/// 데모 토큰 — username:role:hash 조합. 실서비스는 JWT 등으로 대체.
fn demo_token(username: &str, role: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("{username}:{role}:rustra-demo-salt"));
    format!("{role}-{}", hex::encode(&hasher.finalize()[..8]))
}

#[command]
pub fn sign_in(input: SignInInput) -> Result<SignInOutput> {
    // 데모 정책: 비밀번호가 "hunter2" 면 admin, 아니면 일반 사용자.
    let role = if input.password == "hunter2" {
        "admin"
    } else {
        "user"
    };
    let token = demo_token(&input.username, role);
    SESSIONS.lock().unwrap().insert(
        token.clone(),
        Session {
            username: input.username,
            role: role.to_string(),
            granted: Vec::new(),
        },
    );
    Ok(SignInOutput {
        token,
        role: role.to_string(),
    })
}

#[command]
pub fn sign_out(input: SignOutInput) -> Result<SignOutOutput> {
    let removed = SESSIONS.lock().unwrap().remove(&input.token).is_some();
    Ok(SignOutOutput {
        signed_out: removed,
    })
}

#[command]
pub fn grant(input: GrantInput) -> Result<GrantOutput> {
    let mut sessions = SESSIONS.lock().unwrap();
    let granted = if let Some(session) = sessions.get_mut(&input.token) {
        // 데모 정책: admin 세션만 "admin.stats" 를 부여받을 수 있다.
        let allowed = session.role == "admin" && input.capability == "admin.stats";
        if allowed && !session.granted.contains(&input.capability) {
            session.granted.push(input.capability.clone());
        }
        allowed
    } else {
        false
    };
    Ok(GrantOutput { granted })
}

#[command]
pub fn admin_stats(input: AdminStatsInput) -> Result<AdminStatsOutput> {
    // capability 게이트 — deny-by-default. 세션이 "admin.stats" 를 부여받았는지
    // 확인하고, 아니면 핸들러 본문 없이 즉시 거부한다.
    let has_capability = {
        let sessions = SESSIONS.lock().unwrap();
        sessions
            .get(&input.token)
            .is_some_and(|s| s.granted.iter().any(|c| c == "admin.stats"))
    };
    if !has_capability {
        return Err(RustraError::capability_denied(
            "admin.stats required — grant() 로 capability 를 부여하세요 (admin 세션만 가능)",
        ));
    }

    let sessions = SESSIONS.lock().unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let active_users = sessions.values().map(|s| s.username.clone()).collect();
    Ok(AdminStatsOutput {
        sessions: sessions.len() as i64,
        uptime_ms: (now - *STARTED_AT) as i64,
        active_users,
    })
}

pub fn auth_package() -> Package {
    rustra::build!("examples.auth", sign_in, sign_out, grant, admin_stats).done()
}
