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
#include <cstring>
#include <vector>
#include <string>

using namespace facebook::jsi;
namespace gen = rustra::generated;
namespace rc = rustra::codec;

static int g_failures = 0;

namespace rustra::generated {
Value make_array_buffer(Runtime& rt, const uint8_t* data, size_t size) {
  ArrayBuffer buffer(rt, size);
  if (size > 0) std::memcpy(buffer.data(rt), data, size);
  return Value(rt, Object(rt, buffer));
}
} // namespace rustra::generated

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

  // ── Tier 0 raw 슬롯은 런타임 값 모양이 아니라 스키마 종류로 인코딩 ──
  // benchAdd 의 42/58은 정수처럼 보이지만 f64 필드이므로 IEEE-754 비트여야 한다.
  {
    Value args[] = {Value(42.0), Value(58.0)};
    uint64_t slots[] = {0, 0};
    gen::encode_raw_slots(rt, 23, args, 2, slots);
    double a = 0;
    double b = 0;
    std::memcpy(&a, &slots[0], sizeof(a));
    std::memcpy(&b, &slots[1], sizeof(b));
    if (a != 42.0 || b != 58.0) {
      std::printf("FAIL raw benchAdd input slots: a=%f b=%f\n", a, b);
      ++g_failures;
    }

    double sum = 100.0;
    uint64_t sumSlot = 0;
    std::memcpy(&sumSlot, &sum, sizeof(sum));
    Value result = gen::decode_raw_result(rt, 23, sumSlot);
    if (result.getObject(rt).getProperty(rt, "value").asNumber() != 100.0) {
      std::printf("FAIL raw benchAdd output shape\n");
      ++g_failures;
    }
  }

  // Raw eligibility is narrower than positional: string/pair/bytes stay off it.
  // addNumbers is int64-shaped and stays on the JS complex codec so unsafe
  // values can remain bigint. benchAdd is the raw-safe f64 command.
  if (gen::has_raw_codec(1) || !gen::has_raw_codec(23) || gen::has_raw_codec(24) ||
      gen::has_raw_codec(25) || gen::has_raw_codec(26)) {
    std::printf("FAIL raw capability set\n");
    ++g_failures;
  }

  // int64-shaped addNumbers is deliberately not a C++ static codec: the JS
  // complex route owns number|bigint validation and preservation.
  {
    Object args(rt);
    args.setProperty(rt, "a", 42.0);
    args.setProperty(rt, "b", 58.0);
    Value argsV(rt, args);

    rc::Writer w;
    bool ok = gen::encode_by_name(rt, "addNumbers", argsV, w);
    if (ok || !w.take().empty()) {
      std::printf("FAIL addNumbers must remain on the JS complex route\n");
      ++g_failures;
    }
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

  // int64-shaped isEven also stays on the JS complex route.
  {
    Object args(rt);
    args.setProperty(rt, "n", 100.0);
    Value argsV(rt, args);
    rc::Writer w;
    if (gen::encode_by_name(rt, "isEven", argsV, w) || !w.take().empty()) {
      std::printf("FAIL isEven must remain on the JS complex route\n");
      ++g_failures;
    }
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

  // Vec<int64> follows the same BigInt-safe route.
  {
    Object args(rt);
    Array arr(rt, 2);
    arr.setValueAtIndex(rt, 0, 10.0);
    arr.setValueAtIndex(rt, 1, 20.0);
    args.setProperty(rt, "numbers", arr);
    Value argsV(rt, args);
    rc::Writer w;
    if (gen::encode_by_name(rt, "sumList", argsV, w) || !w.take().empty()) {
      std::printf("FAIL sumList must remain on the JS complex route\n");
      ++g_failures;
    }
  }

  // ── native complex codec: map<string, vec<string>> ─────────────────
  // echoGroups is intentionally native-safe. The map keys are sorted by UTF-8
  // bytes and each nested sequence carries its own postcard-style length.
  {
    Object args(rt);
    Object groups(rt);
    Array bValues(rt, 2);
    bValues.setValueAtIndex(rt, 0, String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("y"), 1));
    bValues.setValueAtIndex(rt, 1, String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("z"), 1));
    groups.setProperty(rt, "b", bValues);
    Array aValues(rt, 1);
    aValues.setValueAtIndex(rt, 0, String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("x"), 1));
    groups.setProperty(rt, "a", aValues);
    args.setProperty(rt, "groups", groups);

    rc::Writer w;
    if (!gen::encode_by_name(rt, "echoGroups", Value(rt, args), w)) {
      std::printf("FAIL encode_by_name(echoGroups) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x1B, 0x00, 0x02, 0x01, 0x61, 0x01, 0x01, 0x78,
                           0x01, 0x62, 0x02, 0x01, 0x79, 0x01, 0x7A},
                "encode echoGroups sorted nested map");

    uint8_t body[] = {0x02, 0x01, 0x61, 0x01, 0x01, 0x78,
                      0x01, 0x62, 0x02, 0x01, 0x79, 0x01, 0x7A};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_name(rt, "echoGroups", r);
    Object decodedGroups = result.getObject(rt).getProperty(rt, "groups").getObject(rt);
    Array decodedA = decodedGroups.getProperty(rt, "a").getObject(rt).getArray(rt);
    Array decodedB = decodedGroups.getProperty(rt, "b").getObject(rt).getArray(rt);
    if (decodedA.length(rt) != 1 || decodedA.getValueAtIndex(rt, 0).getString(rt).utf8(rt) != "x" ||
        decodedB.length(rt) != 2 || decodedB.getValueAtIndex(rt, 0).getString(rt).utf8(rt) != "y" ||
        decodedB.getValueAtIndex(rt, 1).getString(rt).utf8(rt) != "z") {
      std::printf("FAIL decode echoGroups nested map\n");
      ++g_failures;
    }
  }

  // ── 2026-08-22 타입 확장: bytes/map/tuple/uvar ─────────────────
  // Rust wire_fixtures.rs · TS cross-wire.test.ts 와 동일 PINNED hex.

  // encode sizeOf {data:[1,2,3,250]} → [cmd 14 LE][len 4][1,2,3,fa]
  {
    Object args(rt);
    Array arr(rt, 4);
    arr.setValueAtIndex(rt, 0, 1.0);
    arr.setValueAtIndex(rt, 1, 2.0);
    arr.setValueAtIndex(rt, 2, 3.0);
    arr.setValueAtIndex(rt, 3, 250.0);
    args.setProperty(rt, "data", arr);
    Value argsV(rt, args);
    rc::Writer w;
    gen::encode_by_name(rt, "sizeOf", argsV, w);
    check_bytes(w.take(), {0x0E, 0x00, 0x04, 0x01, 0x02, 0x03, 0xFA}, "encode sizeOf {[1,2,3,250]}");
  }

  // Dedicated buffer encoder borrows one contiguous span and emits identical
  // postcard bytes without JSI array/property iteration.
  {
    uint8_t data[] = {1, 2, 3, 250};
    rc::Writer w;
    if (gen::has_buffer_codec(14) || !gen::has_buffer_codec(25) ||
        gen::has_buffer_codec(23)) {
      std::printf("FAIL buffer capability set\n");
      ++g_failures;
    }
    gen::encode_buffer_by_id(14, data, sizeof(data), w);
    check_bytes(w.take(), {0x0E, 0x00, 0x04, 0x01, 0x02, 0x03, 0xFA},
                "encode_buffer_by_id sizeOf");

    rc::Writer empty;
    gen::encode_buffer_by_id(25, nullptr, 0, empty);
    check_bytes(empty.take(), {0x19, 0x00, 0x00}, "encode_buffer_by_id empty");

    bool threw = false;
    try {
      rc::Writer unknown;
      gen::encode_buffer_by_id(9999, data, sizeof(data), unknown);
    } catch (const std::invalid_argument&) {
      threw = true;
    }
    if (!threw) { std::printf("FAIL unknown buffer codec must throw\n"); ++g_failures; }
  }

  // The generic/by-id fallback must preserve Uint8Array view bounds when an
  // older native bridge does not expose the dedicated buffer capability.
  {
    ArrayBuffer backing(rt, 6);
    uint8_t raw[] = {99, 1, 2, 3, 250, 88};
    std::memcpy(backing.data(rt), raw, sizeof(raw));
    Object view(rt);
    view.setProperty(rt, "buffer", Object(rt, backing));
    view.setProperty(rt, "byteOffset", 1.0);
    view.setProperty(rt, "byteLength", 4.0);
    view.setProperty(rt, "BYTES_PER_ELEMENT", 1.0);
    Object args(rt);
    args.setProperty(rt, "data", view);
    rc::Writer w;
    if (!gen::encode_by_id(rt, 14, Value(rt, args), w)) {
      std::printf("FAIL encode_by_id(sizeOf Uint8Array view) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x0E, 0x00, 0x04, 0x01, 0x02, 0x03, 0xFA},
                "encode sizeOf partial Uint8Array view");

    view.setProperty(rt, "byteOffset", 5.0);
    view.setProperty(rt, "byteLength", 2.0);
    bool threw = false;
    try {
      rc::Writer outOfBounds;
      gen::encode_by_id(rt, 14, Value(rt, args), outOfBounds);
    } catch (const JSError&) {
      threw = true;
    }
    if (!threw) {
      std::printf("FAIL out-of-bounds Uint8Array view must throw\n");
      ++g_failures;
    }
  }

  // Bytes outputs are returned as a JS-owned ArrayBuffer, not per-byte number[].
  {
    uint8_t body[] = {0x04, 0x01, 0x02, 0x03, 0xFA};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_id(rt, 25, r);
    Object bytesObject = result.getObject(rt).getProperty(rt, "data").getObject(rt);
    if (!bytesObject.isArrayBuffer(rt)) {
      std::printf("FAIL decode bytes must return ArrayBuffer\n");
      ++g_failures;
    } else {
      ArrayBuffer buffer = bytesObject.getArrayBuffer(rt);
      std::vector<uint8_t> actual(buffer.data(rt), buffer.data(rt) + buffer.length(rt));
      check_bytes(actual, {1, 2, 3, 250}, "decode bytes ArrayBuffer");
    }

    uint8_t directBody[] = {1, 2, 3, 250};
    Value directBufferValue = gen::make_array_buffer(rt, directBody, sizeof(directBody));
    Value direct = gen::decode_buffer_result_by_id(rt, 25, std::move(directBufferValue));
    Object directBytes = direct.getObject(rt).getProperty(rt, "data").getObject(rt);
    ArrayBuffer directBuffer = directBytes.getArrayBuffer(rt);
    std::vector<uint8_t> directActual(
        directBuffer.data(rt), directBuffer.data(rt) + directBuffer.length(rt));
    check_bytes(directActual, {1, 2, 3, 250}, "decode direct buffer result");
  }

  // encode scoreTotal {scores:{a:10,b:32}} → [cmd 15][count 2][sorted a,b]
  // map 인코더는 키를 정렬한다(BTreeMap 정합).
  {
    Object args(rt);
    Object scores(rt);
    scores.setProperty(rt, "b", 32.0);
    scores.setProperty(rt, "a", 10.0); // 삽입 순서와 무관하게 a,b 정렬
    args.setProperty(rt, "scores", scores);
    Value argsV(rt, args);
    rc::Writer w;
    if (gen::encode_by_name(rt, "scoreTotal", argsV, w) || !w.take().empty()) {
      std::printf("FAIL scoreTotal must remain on the JS complex route\n");
      ++g_failures;
    }
  }

  // encode span {pair:["hi",-5]} → [cmd 16][str "hi"][zigzag(-5)=9] — tuple 무접두
  {
    Object args(rt);
    Array pair(rt, 2);
    pair.setValueAtIndex(rt, 0, String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("hi"), 2));
    pair.setValueAtIndex(rt, 1, -5.0);
    args.setProperty(rt, "pair", pair);
    Value argsV(rt, args);
    rc::Writer w;
    if (gen::encode_by_name(rt, "span", argsV, w) || !w.take().empty()) {
      std::printf("FAIL span must remain on the JS complex route\n");
      ++g_failures;
    }
  }

  // encode gauge {limit:300, offset:70000} → [cmd 17][ac 02][f0 a2 04] — plain varint
  {
    Object args(rt);
    args.setProperty(rt, "limit", 300.0);
    args.setProperty(rt, "offset", 70000.0);
    Value argsV(rt, args);
    rc::Writer w;
    if (gen::encode_by_name(rt, "gauge", argsV, w) || !w.take().empty()) {
      std::printf("FAIL gauge must remain on the JS complex route\n");
      ++g_failures;
    }
  }

  // decode scoreTotal response body postcard(count=2,total=42) → 구조 검증
  {
    if (gen::has_static_codec("scoreTotal")) {
    uint8_t body[] = {0x02, 0x54}; // uvar(2), zigzag(42)
    rc::Reader r(body, 2);
    Value result = gen::decode_by_name(rt, "scoreTotal", r);
    Object obj = result.getObject(rt);
    if (obj.getProperty(rt, "count").asNumber() != 2.0) {
      std::printf("FAIL decode scoreTotal count\n"); ++g_failures;
    }
    if (obj.getProperty(rt, "total").asNumber() != 42.0) {
      std::printf("FAIL decode scoreTotal total\n"); ++g_failures;
    }
    }
  }

  // decode span response body postcard(first="hi",second=-5) → tuple 재조립
  {
    if (gen::has_static_codec("span")) {
    uint8_t body[] = {0x02, 0x68, 0x69, 0x09};
    rc::Reader r(body, 4);
    Value result = gen::decode_by_name(rt, "span", r);
    Object obj = result.getObject(rt);
    if (obj.getProperty(rt, "first").getString(rt).utf8(rt) != "hi") {
      std::printf("FAIL decode span first\n"); ++g_failures;
    }
    if (obj.getProperty(rt, "second").asNumber() != -5.0) {
      std::printf("FAIL decode span second (zigzag)\n"); ++g_failures;
    }
    }
  }

  // decode gauge response body postcard(next=70300) → uvar 정밀도
  {
    if (gen::has_static_codec("gauge")) {
    uint8_t body[] = {0x9C, 0xA5, 0x04}; // uvar(70300)
    rc::Reader r(body, 3);
    Value result = gen::decode_by_name(rt, "gauge", r);
    Object obj = result.getObject(rt);
    if (obj.getProperty(rt, "next").asNumber() != 70300.0) {
      std::printf("FAIL decode gauge next (uvar)\n"); ++g_failures;
    }
    }
  }

  // addNumbers has no C++ decoder for the same BigInt-safe reason as its
  // encoder; the generated JS complex codec handles this response.
  if (gen::has_static_codec("addNumbers")) {
    std::printf("FAIL addNumbers must not advertise a C++ static codec\n");
    ++g_failures;
  }

  // ── decode isEven response body postcard(result=true) → {result:true} ──
  {
    if (gen::has_static_codec("isEven")) {
    uint8_t body[] = {0x01}; // bool true
    rc::Reader r(body, 1);
    Value result = gen::decode_by_name(rt, "isEven", r);
    Object obj = result.getObject(rt);
    bool b = obj.getProperty(rt, "result").getBool();
    if (!b) { std::printf("FAIL decode isEven result: got false, want true\n"); ++g_failures; }
    }
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
    if (gen::has_static_codec("sumList")) {
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
  // 정적 코덱에 존재하는 greet 만 C++ 교차 검증 가능. addNumbers 는
  // int64/BigInt 안전성을 위해 JS complex codec 경로로 분리된다.
  // divide·secureCompute 는 동적 명령(C++ static codec 없음 → JS Tier 3 fallback)
  // 이므로 divide 에러 프레임은 Rust↔TS 교차 증명(cross-wire.test.ts)에 한정.

  // (1) encode greet {name:"Lynx"} → [cmd 5 LE][len 4]['L']['y']['n']['x']
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

  // (2) decode greet 응답 바디 (body = len 12 + "Hello, Lynx!")
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
    if (gen::has_static_codec("addNumbers")) { std::printf("FAIL has_static_codec(addNumbers) should be false\n"); ++g_failures; }
    if (!gen::has_static_codec("echoGroups")) { std::printf("FAIL has_static_codec(echoGroups)\n"); ++g_failures; }
    if (!gen::has_static_codec("rustraRegistryDemo")) { std::printf("FAIL has_static_codec(rustraRegistryDemo)\n"); ++g_failures; }
    if (gen::has_static_codec("dynamicCmd")) { std::printf("FAIL has_static_codec(dynamicCmd) should be false\n"); ++g_failures; }
  }

  // ── encode_by_id / decode_by_id (P0-3: u16 디스패치) ──
  // by_name 과 동일한 per-command 함수를 재사용하므로 바이트/값이 완전히
  // 동일해야 한다 — switch 케이스가 잘못 매핑되면 즉시 드러난다.

  // (1) encode_by_id(addNumbers=1) is delegated to the JS complex route.
  {
    Object args(rt);
    args.setProperty(rt, "a", 42.0);
    args.setProperty(rt, "b", 58.0);
    Value argsV(rt, args);
    rc::Writer w;
    bool ok = gen::encode_by_id(rt, 1, argsV, w);
    if (ok || !w.take().empty()) {
      std::printf("FAIL encode_by_id(1) must return false for JS complex route\n");
      ++g_failures;
    }
  }

  // (2) encode_by_id(greet=5) — 다른 케이스도 정확히 매핑되는지
  {
    Object args(rt);
    args.setProperty(rt, "name", String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("hi"), 2));
    Value argsV(rt, args);
    rc::Writer w;
    bool ok = gen::encode_by_id(rt, 5, argsV, w);
    if (!ok) { std::printf("FAIL encode_by_id(5) returned false\n"); ++g_failures; }
    check_bytes(w.take(), {0x05, 0x00, 0x02, 0x68, 0x69}, "encode_by_id greet {hi}");
  }

  // (3) decode_by_id(greet=5) round-trip — "yo"
  {
    uint8_t body[] = {0x02, 0x79, 0x6F};
    rc::Reader r(body, 3);
    Value result = gen::decode_by_id(rt, 5, r);
    std::string s = result.getObject(rt).getProperty(rt, "message").getString(rt).utf8(rt);
    if (s != "yo") { std::printf("FAIL decode_by_id(5) message: got <%s>, want yo\n", s.c_str()); ++g_failures; }
  }

  // (5) 존재하지 않는 cmd_id — encode 는 false, decode 는 throw
  {
    Object args(rt);
    Value argsV(rt, args);
    rc::Writer w;
    if (gen::encode_by_id(rt, 9999, argsV, w)) {
      std::printf("FAIL encode_by_id(9999) should return false\n"); ++g_failures;
    }
    uint8_t body[] = {0x00};
    rc::Reader r(body, 1);
    bool threw = false;
    try {
      gen::decode_by_id(rt, 9999, r);
    } catch (const JSError&) {
      threw = true;
    }
    if (!threw) { std::printf("FAIL decode_by_id(9999) should throw JSError\n"); ++g_failures; }
  }

  if (g_failures == 0) {
    std::printf("OK: all generated-codec tests passed\n");
    return 0;
  }
  std::printf("FAILED: %d check(s)\n", g_failures);
  return 1;
}
