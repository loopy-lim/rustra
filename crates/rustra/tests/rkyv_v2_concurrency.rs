//! 동시성 스모크 테스트 — RwLock 기반 런타임 레지스트리의 스레드 안전성.
//!
//! `loom` 정합성 모델은 범위 밖; 실제 OS 스레드로 패닉/교착/데이터레이스가
//! 발생하지 않음을 확인한다. `register`(동적)는 debug 빌드에서만 동작.

#![allow(clippy::float_cmp)]
#![cfg_attr(not(debug_assertions), allow(unused_imports))]

use rustra::Package;
use std::sync::Arc;
use std::thread;

#[path = "../benches/common.rs"]
mod common;

/// 동적 echo 를 여러 스레드가 동시에 호출 → 패닉 없이 모두 정확.
#[test]
#[cfg(debug_assertions)]
fn concurrent_invoke_dynamic_no_panic() {
    let pkg = Arc::new(
        Package::builder("conc.invoke")
            .command("add", common::add)
            .build(),
    );
    pkg.register("echo", common::echo).unwrap();
    let echo_id = common::command_id_of(&pkg, "echo");

    let n_threads = 8;
    let per_thread = 500;
    let handles: Vec<_> = (0..n_threads)
        .map(|t| {
            let pkg = Arc::clone(&pkg);
            thread::spawn(move || {
                let base = t as i64;
                for i in 0..per_thread {
                    let v = base * 1000 + i;
                    // (T2-1) 동적 echo 도 postcard 지원 형태 → binary 핸들러.
                    let req = common::postcard_request(echo_id, &common::EchoInput { v });
                    let resp = pkg.invoke_rkyv_v2(&req).expect("invoke ok");
                    let out: common::EchoOutput = common::decode_postcard_response(&resp);
                    assert_eq!(out.v, v, "echo must preserve value");
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("thread must not panic");
    }
}

/// 각 스레드가 서로 다른 동적 명령을 등록한 뒤 호출 → 패닉/데이터레이스 없음.
#[test]
#[cfg(debug_assertions)]
fn concurrent_register_distinct_then_invoke() {
    let pkg = Arc::new(Package::builder("conc.register").build());
    let n = 16;
    let handles: Vec<_> = (0..n)
        .map(|t| {
            let pkg = Arc::clone(&pkg);
            thread::spawn(move || {
                let name = format!("cmd{t}");
                // 핸들러: 입력값을 그대로 echo (고유 base).
                let base = t as i64;
                pkg.register(
                    &name,
                    move |input: common::EchoInput| -> rustra::Result<common::EchoOutput> {
                        Ok(common::EchoOutput { v: input.v + base })
                    },
                )
                .expect("register ok");
            })
        })
        .collect();
    for h in handles {
        h.join().expect("register thread must not panic");
    }

    // 각 명령이 자기 id 로 호출 가능한지 확인.
    let schema = pkg.live_schema();
    for t in 0..n {
        let name = format!("cmd{t}");
        let entry = schema["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let id = entry["commandId"].as_u64().unwrap() as u16;
        // (T2-1) 동적 등록 명령도 postcard 지원 형태 → binary 핸들러.
        let req = common::postcard_request(id, &common::EchoInput { v: 0 });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::EchoOutput = common::decode_postcard_response(&resp);
        assert_eq!(out.v, t as i64);
    }
}

/// writer(register/unregister) + reader(invoke/live_schema) 동시 혼합 → 패닉 없음.
#[test]
#[cfg(debug_assertions)]
fn concurrent_mutation_and_read_no_panic() {
    let pkg = Arc::new(Package::builder("conc.mixed").build());
    // 시작 명령 하나
    pkg.register("stable", common::echo).unwrap();

    let pkg_w = Arc::clone(&pkg);
    let writer = thread::spawn(move || {
        for i in 0..200 {
            let name = format!("dyn{i}");
            let _ = pkg_w.register(&name, common::echo);
            if i % 2 == 0 {
                let _ = pkg_w.unregister(&name);
            }
        }
    });

    let pkg_r = Arc::clone(&pkg);
    let reader = thread::spawn(move || {
        let stable_id = common::command_id_of(&pkg_r, "stable");
        for _ in 0..1000 {
            // stable 은 항상 존재 → invoke 는 성공해야 함 (postcard binary)
            let req = common::postcard_request(stable_id, &common::EchoInput { v: 1 });
            let _ = pkg_r.invoke_rkyv_v2(&req);
            // live_schema 도 read 잠금 → writer 와 교착/패닉 없어야 함
            let _ = pkg_r.live_schema();
        }
    });

    writer.join().expect("writer must not panic");
    reader.join().expect("reader must not panic");
    // stable 은 여전히 호출 가능
    let sid = common::command_id_of(&pkg, "stable");
    let req = common::postcard_request(sid, &common::EchoInput { v: 42 });
    let resp = pkg.invoke_rkyv_v2(&req).unwrap();
    let out: common::EchoOutput = common::decode_postcard_response(&resp);
    assert_eq!(out.v, 42);
}
