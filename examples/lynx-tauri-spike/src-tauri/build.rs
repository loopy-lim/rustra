// lynx_desktop.mm(Objective-C++) 를 cc 로 컴파일하고 Lynx SDK + rustra staticlib +
// macOS 프레임워크 링크 directive 를 내보낸다. host/build.sh 의 clang++ 링크와 동등.
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    let sdk = std::env::var("LYNX_SDK").unwrap_or_else(|_| "/tmp/lynx-prebuilt/macsdk".to_string());
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // examples/lynx-tauri-spike/src-tauri → repo root (3 단계 상위)
    let repo_root = manifest_dir
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf();
    // rustra staticlib 는 별도 cargo build 로 만들어지므로 profile 이 다를 수 있다.
    // release → debug 순으로 실제 파일을 찾는다.
    let static_dir = {
        let target = repo_root.join("target");
        let mut found = None;
        for p in ["release", "debug"] {
            let f = target.join(p).join("librustra_calculator_example.a");
            if f.exists() {
                found = Some(target.join(p));
                break;
            }
        }
        found.unwrap_or_else(|| target.join("release"))
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

    // rustra staticlib (host.cpp 와 동일: .a 직접 링크)
    println!("cargo:rustc-link-search=native={}", static_dir.display());
    println!("cargo:rustc-link-lib=static=rustra_calculator_example");

    // macOS frameworks (host/build.sh 와 동일 세트)
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
