// lynx_desktop.mm(Objective-C++) 를 cc 로 컴파일하고 Lynx SDK + rustra backend
// staticlib + macOS 프레임워크 링크 directive 를 내보낸다.
// 스파이크 examples/lynx-tauri-spike/src-tauri/build.rs 에서 정제 추출 —
// staticlib 탐색 대상이 스파이크 crate 가 아닌 템플릿 backend(독립 workspace)로 다르다.
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        build_windows();
        return;
    }

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

/// Windows 빌드 — lynx_desktop_win.cpp 컴파일 + lynx.dll 링크.
/// MSVC + Windows SDK + lynx_sdk_windows_x64 (LYNX_SDK) 전제. 자세한 절차는
/// ../WINDOWS.md 참조. FML 심볼 해석 크럭스는 소스 내 주석(포인트 3) 참고.
fn build_windows() {
    let sdk = std::env::var("LYNX_SDK").expect("LYNX_SDK must point to lynx_sdk_windows_x64");

    cc::Build::new()
        .cpp(true)
        .file("src/lynx_desktop_win.cpp")
        .flag("-std=c++17")
        .flag("-DUSE_WEAK_SUFFIX_NAPI")
        .include(format!("{}/include", sdk))
        .compile("lynx_desktop_win");

    // Windows SDK: lynx.dll (LYNX_SDK/bin 또는 LYNX_SDK/lib — 배포 레이아웃 확인 필요)
    for lib_dir in ["bin", "lib"] {
        let p = format!("{}/{}", sdk, lib_dir);
        if std::path::Path::new(&p).exists() {
            println!("cargo:rustc-link-search=native={}", p);
        }
    }
    println!("cargo:rustc-link-lib=dylib=lynx");

    // rustra backend staticlib — macOS 분기와 동일 탐색 (확장자 .a는 Windows에서도
    // cargo build --manifest-path backend/Cargo.toml 산출물 그대로 사용 가능).
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let template_root = manifest_dir
        .ancestors()
        .nth(2)
        .expect("template root")
        .to_path_buf();
    let backend_target = template_root.join("backend").join("target");
    let static_dir = ["release", "debug"]
        .iter()
        .find(|p| {
            backend_target
                .join(p)
                .join("librustra_template_backend.a")
                .exists()
        })
        .map(|p| backend_target.join(p))
        .unwrap_or_else(|| backend_target.join("release"));
    println!("cargo:rustc-link-search=native={}", static_dir.display());
    println!("cargo:rustc-link-lib=static=rustra_template_backend");

    println!("cargo:rustc-link-lib=user32"); // Win32 HWND API
    println!("cargo:rerun-if-env-changed=LYNX_SDK");
    println!("cargo:rerun-if-changed=src/lynx_desktop_win.cpp");
}
