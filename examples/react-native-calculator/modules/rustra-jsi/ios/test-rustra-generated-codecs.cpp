// test-rustra-generated-codecs.cpp — 생성된 C++ 코덱의 컴파일 + round-trip 검증.
//
// 목적: rustra-generated-codecs.{hpp,cpp} 가 (1) 실제로 컴파일되고,
//      (2) JSI 값을 postcard 바이트로 인코딩한 결과가 Rust `postcard` 와 바이트-동일하며,
//      (3) 응답 postcard 바디를 다시 JSI 값으로 디코딩해 값이 보존되는지 확인.
//
// RN 의 진짜 jsi/jsi.h 대신 아래 test-jsi-shim.hpp 의 최소 shim 을 링크한다.
// 실제 디바이스 빌드(Xcode + React-Common)는 별도 검증 항목.
//
// 빌드/실행 (간단히):  ./run-cpp-codec-tests.sh
//
// 수동 빌드 — test-jsi-shim.hpp 가 facebook::jsi 를 정의하므로, <jsi/jsi.h> 는
// 빈 stub 으로 치환하고 shim 을 force-include 한다:
//   mkdir -p /tmp/b/jsi && printf '#pragma once\n' > /tmp/b/jsi/jsi.h
//   clang++ -std=c++17 -O2 -Wall -Wextra -I<ios_dir> -I/tmp/b -include test-jsi-shim.hpp \
//     test-rustra-generated-codecs.cpp rustra-generated-codecs.cpp -o /tmp/tgen && /tmp/tgen

#include "test-jsi-shim.hpp"

#include "rustra-generated-codecs.hpp"

#include <cstdio>
#include <vector>
#include <string>

using namespace facebook::jsi;
namespace gen = rustra::generated;
namespace rc = rustra::codec;

static int g_failures = 0;

static void check_bytes(const std::vector<uint8_t>& actual,
                        const std::vector<uint8_t>& expected,
                        const char* msg) {
  if (actual != expected) {
    std::printf("FAIL %s:\n  got:  ", msg);
    for (auto b : actual) std::printf("%02X ", b);
    std::printf("\n  want: ");
    for (auto b : expected) std::printf("%02X ", b);
    std::printf("\n");
    ++g_failures;
  }
}

int main() {
  Runtime rt;

  // ── encode addNumbers {a:42, b:58} → [cmd_id 1 LE][postcard(42,58)] ──
  {
    Object args(rt);
    args.setProperty(rt, "a", 42.0);
    args.setProperty(rt, "b", 58.0);
    Value argsV(rt, args);

    rc::Writer w;
    bool ok = gen::encode_by_name(rt, "addNumbers", argsV, w);
    if (!ok) { std::printf("FAIL encode_by_name(addNumbers) returned false\n"); ++g_failures; }
    check_bytes(w.take(), {0x01, 0x00, 0x54, 0x74}, "encode addNumbers {42,58}");
  }

  // ── encode multiply {a:1.5, b:2.5} → [cmd_id 2 LE][f64(1.5)][f64(2.5)] ──
  {
    Object args(rt);
    args.setProperty(rt, "a", 1.5);
    args.setProperty(rt, "b", 2.5);
    Value argsV(rt, args);

    rc::Writer w;
    gen::encode_by_name(rt, "multiply", argsV, w);
    // cmd_id 2 LE + 두 f64 (little-endian)
    std::vector<uint8_t> want = {0x02, 0x00,
      0x00,0x00,0x00,0x00,0x00,0x00,0xF8,0x3F, // 1.5
      0x00,0x00,0x00,0x00,0x00,0x00,0x04,0x40}; // 2.5
    check_bytes(w.take(), want, "encode multiply {1.5,2.5}");
  }

  // ── encode isEven {n:100} → [cmd_id 3 LE][varint(100)] ──
  {
    Object args(rt);
    args.setProperty(rt, "n", 100.0);
    Value argsV(rt, args);
    rc::Writer w;
    gen::encode_by_name(rt, "isEven", argsV, w);
    check_bytes(w.take(), {0x03, 0x00, 0xC8, 0x01}, "encode isEven {100}");
  }

  // ── encode greet {name:"hi"} → [cmd_id 5 LE][str len 2]['h']['i']] ──
  {
    Object args(rt);
    args.setProperty(rt, "name", String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("hi"), 2));
    Value argsV(rt, args);
    rc::Writer w;
    gen::encode_by_name(rt, "greet", argsV, w);
    check_bytes(w.take(), {0x05, 0x00, 0x02, 0x68, 0x69}, "encode greet {hi}");
  }

  // ── encode sumList {numbers:[10,20]} → [cmd_id 6 LE][count 2][10][20]] ──
  {
    Object args(rt);
    Array arr(rt, 2);
    arr.setValueAtIndex(rt, 0, 10.0);
    arr.setValueAtIndex(rt, 1, 20.0);
    args.setProperty(rt, "numbers", arr);
    Value argsV(rt, args);
    rc::Writer w;
    gen::encode_by_name(rt, "sumList", argsV, w);
    check_bytes(w.take(), {0x06, 0x00, 0x02, 0x14, 0x28}, "encode sumList {[10,20]}");
  }

  // ── decode addNumbers response body postcard(value=100) → {value:100} ──
  {
    // value=100 → postcard varint 0xC8,0x01
    uint8_t body[] = {0xC8, 0x01};
    rc::Reader r(body, 2);
    Value result = gen::decode_by_name(rt, "addNumbers", r);
    Object obj = result.getObject(rt);
    double v = obj.getProperty(rt, "value").asNumber();
    if (v != 100.0) { std::printf("FAIL decode addNumbers value: got %f, want 100\n", v); ++g_failures; }
  }

  // ── decode isEven response body postcard(result=true) → {result:true} ──
  {
    uint8_t body[] = {0x01}; // bool true
    rc::Reader r(body, 1);
    Value result = gen::decode_by_name(rt, "isEven", r);
    Object obj = result.getObject(rt);
    bool b = obj.getProperty(rt, "result").getBool();
    if (!b) { std::printf("FAIL decode isEven result: got false, want true\n"); ++g_failures; }
  }

  // ── decode greet response body postcard(message="yo") → {message:"yo"} ──
  {
    uint8_t body[] = {0x02, 0x79, 0x6F}; // len 2 + "yo"
    rc::Reader r(body, 3);
    Value result = gen::decode_by_name(rt, "greet", r);
    Object obj = result.getObject(rt);
    std::string s = obj.getProperty(rt, "message").getString(rt).utf8(rt);
    if (s != "yo") { std::printf("FAIL decode greet message: got <%s>, want yo\n", s.c_str()); ++g_failures; }
  }

  // ── decode sumList response body {count,total} → {count:2,total:30} ──
  {
    // count=2 → 0x04; total=30 → 0x3C
    uint8_t body[] = {0x04, 0x3C};
    rc::Reader r(body, 2);
    Value result = gen::decode_by_name(rt, "sumList", r);
    Object obj = result.getObject(rt);
    double count = obj.getProperty(rt, "count").asNumber();
    double total = obj.getProperty(rt, "total").asNumber();
    if (count != 2.0 || total != 30.0) {
      std::printf("FAIL decode sumList: count=%f total=%f, want 2/30\n", count, total);
      ++g_failures;
    }
  }

  // ── decode rustraRegistryDemo response: struct 순서 ok,frozen,message 검증 ──
  // Rust 가 postcard(RegistryDemoOutput) 를 구조체 순서(ok,frozen,message)로 직렬화.
  {
    uint8_t body[] = {0x01 /*ok=true*/, 0x00 /*frozen=false*/, 0x02,'h','i' /*msg="hi"*/};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_name(rt, "rustraRegistryDemo", r);
    Object obj = result.getObject(rt);
    bool ok = obj.getProperty(rt, "ok").getBool();
    bool frozen = obj.getProperty(rt, "frozen").getBool();
    std::string msg = obj.getProperty(rt, "message").getString(rt).utf8(rt);
    if (!ok || frozen || msg != "hi") {
      std::printf("FAIL decode rustraRegistryDemo: ok=%d frozen=%d msg=<%s>\n", ok, frozen, msg.c_str());
      ++g_failures;
    }
  }

  // ── shared-fixture cross-check (Task 2.5): Rust↔TS↔C++ 동일 바이트 ──────
  // examples/calculator/tests/wire_fixtures.rs (Rust) 와
  // examples/calculator/ts/cross-wire.test.ts (TS) 가 공유하는 canonical hex 를
  // generated C++ codec 이 동일하게 encode/decode 함을 증명한다. 코너 하나라도
  // 드리프트하면 세 테스트 중 하나가 실패 → 스키마/코덱 회귀 감지.
  //
  // 정적 코덱에 존재하는 addNumbers/greet 만 C++ 교차 검증 가능.
  // divide·secureCompute 는 동적 명령(C++ static codec 없음 → JS Tier 3 fallback)
  // 이므로 divide 에러 프레임은 Rust↔TS 교차 증명(cross-wire.test.ts)에 한정.

  // (1) encode addNumbers {a:2,b:3} → [cmd 1 LE][zigzag(2)=04][zigzag(3)=06]
  //     == Rust/TS ADDNUMBERS_REQUEST "01000406"
  {
    Object args(rt);
    args.setProperty(rt, "a", 2.0);
    args.setProperty(rt, "b", 3.0);
    Value argsV(rt, args);
    rc::Writer w;
    gen::encode_by_name(rt, "addNumbers", argsV, w);
    check_bytes(w.take(), {0x01, 0x00, 0x04, 0x06}, "shared-fixture encode addNumbers {2,3}");
  }

  // (2) encode greet {name:"Lynx"} → [cmd 5 LE][len 4]['L']['y']['n']['x']
  //     == Rust/TS GREET_REQUEST "0500044c796e78"
  {
    Object args(rt);
    args.setProperty(rt, "name",
                    String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("Lynx"), 4));
    Value argsV(rt, args);
    rc::Writer w;
    gen::encode_by_name(rt, "greet", argsV, w);
    check_bytes(w.take(), {0x05, 0x00, 0x04, 0x4c, 0x79, 0x6e, 0x78},
                "shared-fixture encode greet {Lynx}");
  }

  // (3) decode addNumbers 응답 바디 (프레임 [ok:1][7B 0][body] 중 body=0x0a → 5)
  //     전체 프레임 == Rust/TS ADDNUMBERS_RESPONSE "01000000000000000a"
  {
    std::vector<uint8_t> frame = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a};
    rc::Reader r(frame.data() + 8, frame.size() - 8);  // 8바이트 프레임 헤더 건너뜀
    Value result = gen::decode_by_name(rt, "addNumbers", r);
    double v = result.getObject(rt).getProperty(rt, "value").asNumber();
    if (v != 5.0) {
      std::printf("FAIL shared-fixture decode addNumbers: got %f, want 5\n", v);
      ++g_failures;
    }
  }

  // (4) decode greet 응답 바디 (body = len 12 + "Hello, Lynx!")
  //     전체 프레임 == Rust/TS GREET_RESPONSE "01000000000000000c48656c6c6f2c204c796e7821"
  {
    std::vector<uint8_t> frame = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                  0x0c, 'H', 'e', 'l', 'l', 'o', ',', ' ',
                                  'L',  'y', 'n', 'x', '!'};
    rc::Reader r(frame.data() + 8, frame.size() - 8);
    Value result = gen::decode_by_name(rt, "greet", r);
    std::string s = result.getObject(rt).getProperty(rt, "message").getString(rt).utf8(rt);
    if (s != "Hello, Lynx!") {
      std::printf("FAIL shared-fixture decode greet: got <%s>, want Hello, Lynx!\n", s.c_str());
      ++g_failures;
    }
  }

  // ── has_static_codec / dispatch ──
  {
    if (!gen::has_static_codec("addNumbers")) { std::printf("FAIL has_static_codec(addNumbers)\n"); ++g_failures; }
    if (!gen::has_static_codec("rustraRegistryDemo")) { std::printf("FAIL has_static_codec(rustraRegistryDemo)\n"); ++g_failures; }
    if (gen::has_static_codec("dynamicCmd")) { std::printf("FAIL has_static_codec(dynamicCmd) should be false\n"); ++g_failures; }
  }

  if (g_failures == 0) {
    std::printf("OK: all generated-codec tests passed\n");
    return 0;
  }
  std::printf("FAILED: %d check(s)\n", g_failures);
  return 1;
}
