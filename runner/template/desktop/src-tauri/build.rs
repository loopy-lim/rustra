// lynx_desktop.mm(Objective-C++) 를 cc 로 컴파일하고 Lynx SDK + rustra backend
// staticlib + macOS 프레임워크 링크 directive 를 내보낸다.
// 스파이크 examples/lynx-tauri-spike/src-tauri/build.rs 에서 정제 추출 —
// staticlib 탐색 대상이 스파이크 crate 가 아닌 템플릿 backend(독립 workspace)로 다르다.
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    let sdk = std::env::var("LYNX_SDK").unwrap_or_else(|_| "/tmp/lynx-prebuilt/macsdk".to_string());
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // runner/template/desktop/src-tauri → 템플릿 루트 runner/template (2 단계 상위).
    let template_root = manifest_dir
        .ancestors()
        .nth(2)
        .expect("template root")
        .to_path_buf();
    // 템플릿 backend 는 독립 workspace ([workspace] 빌려주기) 이므로 산출물은
    // backend/target/<profile>/librustra_template_backend.a. release → debug 순 탐색.
    let static_dir = {
        let backend_target = template_root.join("backend").join("target");
        let mut found = None;
        for p in ["release", "debug"] {
            let f = backend_target.join(p).join("librustra_template_backend.a");
            if f.exists() {
                found = Some(backend_target.join(p));
                break;
            }
        }
        found.unwrap_or_else(|| backend_target.join("release"))
    };

    // lynx_desktop.mm → liblynx_desktop.a
    cc::Build::new()
        .cpp(true)
        .file("src/lynx_desktop.mm")
        .flag("-std=c++17")
        .flag("-DUSE_WEAK_SUFFIX_NAPI")
        .include(format!("{}/include", sdk))
        .compile("lynx_desktop");

    // Lynx dylib
    println!("cargo:rustc-link-search=native={}/lib", sdk);
    println!("cargo:rustc-link-lib=dylib=Lynx");

    // rustra backend staticlib (.a 직접 링크 — Cargo dep 로 두면 rlib 만 링크되어
    // extern "C" 심볼이 보이지 않는다; 스파이크와 동일 이유).
    println!("cargo:rustc-link-search=native={}", static_dir.display());
    println!("cargo:rustc-link-lib=static=rustra_template_backend");

    // macOS frameworks (스파이크 host/build.sh 와 동일 세트)
    for fw in [
        "Cocoa",
        "Foundation",
        "CoreGraphics",
        "Metal",
        "MetalKit",
        "OpenGL",
        "QuartzCore",
        "IOKit",
        "CoreFoundation",
        "ImageIO",
    ] {
        println!("cargo:rustc-link-framework={}", fw);
    }
    // libLynx.dylib 런타임 탐색 경로
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}/lib", sdk);

    println!("cargo:rerun-if-env-changed=LYNX_SDK");
    println!("cargo:rerun-if-changed=src/lynx_desktop.mm");
}
