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

#include <cstdint>
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

  // Raw eligibility mirrors the Rust raw_invoke_shape contract: up to three
  // scalar fields, and since B1 that includes int64/uint64 (the u64 slot
  // carries the full-width value). benchAdd/clamp are the raw-safe f64s;
  // benchEchoBytes(25)/benchEchoPair(26)/wideAgg(28)/tagSet(29) stay off raw.
  if (!gen::has_raw_codec(1) || !gen::has_raw_codec(23) || gen::has_raw_codec(24) ||
      gen::has_raw_codec(25) || gen::has_raw_codec(26) || gen::has_raw_codec(28) ||
      gen::has_raw_codec(29)) {
    std::printf("FAIL raw capability set\n");
    ++g_failures;
  }

  // ── B1: raw-tier wide restore. addNumbers(1) 는 raw 슬롯이 int64 비트를
  // 운반하고 decode_raw_result 가 safe 범위 밖에서 BigInt 로 복원한다.
  {
    // encode_raw_slots accepts a bigint input (positional path) and stores the
    // full-width i64 bits: a = i64::MIN, b = 58.
    Value args[] = {Value(rt, jsi::BigInt::fromInt64(rt, INT64_MIN)), Value(58.0)};
    uint64_t slots[] = {0, 0};
    gen::encode_raw_slots(rt, 1, args, 2, slots);
    int64_t a = 0;
    std::memcpy(&a, &slots[0], sizeof(a));
    int64_t b = 0;
    std::memcpy(&b, &slots[1], sizeof(b));
    if (a != INT64_MIN || b != 58) {
      std::printf("FAIL raw addNumbers bigint input slots: a=%lld b=%lld\n",
                  (long long)a, (long long)b);
      ++g_failures;
    }

    // Out-of-safe-range raw restore: slot bits = 2^53+1 → BigInt.
    int64_t beyond = 9007199254740993LL;
    uint64_t beyondSlot = 0;
    std::memcpy(&beyondSlot, &beyond, sizeof(beyondSlot));
    Value result = gen::decode_raw_result(rt, 1, beyondSlot);
    Value value = result.getObject(rt).getProperty(rt, "value");
    if (!value.isBigInt() || value.asBigInt(rt).asInt64(rt) != 9007199254740993LL) {
      std::printf("FAIL raw restore 2^53+1 must be BigInt\n");
      ++g_failures;
    }

    // gauge(17) raw restore: slot = u64::MAX → BigInt.
    Value umax = gen::decode_raw_result(rt, 17, UINT64_MAX);
    Value next = umax.getObject(rt).getProperty(rt, "next");
    if (!next.isBigInt() || next.asBigInt(rt).asUint64(rt) != UINT64_MAX) {
      std::printf("FAIL raw restore u64::MAX must be BigInt\n");
      ++g_failures;
    }
  }

  // ── B1: int64 addNumbers is a C++ static codec now. Safe integers stay
  // number; the validator also accepts bigint via jsi::BigInt::asInt64.
  {
    Object args(rt);
    args.setProperty(rt, "a", 42.0);
    args.setProperty(rt, "b", 58.0);
    Value argsV(rt, args);

    rc::Writer w;
    if (!gen::encode_by_name(rt, "addNumbers", argsV, w)) {
      std::printf("FAIL encode_by_name(addNumbers) returned false\n");
      ++g_failures;
    }
    // zigzag(42)=84 → 0x54, zigzag(58)=116 → 0x74.
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

  // int64 isEven joins the C++ static codec the same way (B1).
  {
    Object args(rt);
    args.setProperty(rt, "n", 100.0);
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_name(rt, "isEven", argsV, w)) {
      std::printf("FAIL encode_by_name(isEven) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x03, 0x00, 0xc8, 0x01}, "encode isEven {100}");
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

  // Vec<int64> elements ride the native codec too — per-element zigzag64.
  {
    Object args(rt);
    Array arr(rt, 2);
    arr.setValueAtIndex(rt, 0, 10.0);
    arr.setValueAtIndex(rt, 1, 20.0);
    args.setProperty(rt, "numbers", arr);
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_name(rt, "sumList", argsV, w)) {
      std::printf("FAIL encode_by_name(sumList) returned false\n");
      ++g_failures;
    }
    // zigzag(10)=20 → 0x14, zigzag(20)=40 → 0x28.
    check_bytes(w.take(), {0x06, 0x00, 0x02, 0x14, 0x28}, "encode sumList {[10,20]}");
  }

  // B1 encode: bigint input beyond the safe range must survive losslessly.
  {
    Object args(rt);
    Array arr(rt, 2);
    arr.setValueAtIndex(rt, 0, Value(rt, jsi::BigInt::fromInt64(rt, INT64_MIN)));
    arr.setValueAtIndex(rt, 1, 5.0);
    args.setProperty(rt, "numbers", arr);
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_name(rt, "sumList", argsV, w)) {
      std::printf("FAIL encode_by_name(sumList bigint) returned false\n");
      ++g_failures;
    }
    // zigzag(i64::MIN) = u64::MAX → 10-byte LEB128 ff×9 + 01.
    check_bytes(w.take(),
                {0x06, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
                 0x0a},
                "encode sumList {[i64::MIN,5]} bigint");
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
    // echoGroups — id 27 (wide_agg/tag_set 은 builder 체인 맨 뒤로 이동해
    // 28/29 로 할당된다 — 기존 커맨드 id 시프트 없음).
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
  // map<int64> 인코더는 키를 정렬하고(BTreeMap 정합) 값을 zigzag64로 보낸다.
  {
    Object args(rt);
    Object scores(rt);
    scores.setProperty(rt, "b", 32.0);
    scores.setProperty(rt, "a", 10.0); // 삽입 순서와 무관하게 a,b 정렬
    args.setProperty(rt, "scores", scores);
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_name(rt, "scoreTotal", argsV, w)) {
      std::printf("FAIL encode_by_name(scoreTotal) returned false\n");
      ++g_failures;
    }
    // [cmd 15 LE][count 2]["a" zigzag(10)=14]["b" zigzag(32)=64]
    check_bytes(w.take(), {0x0f, 0x00, 0x02, 0x01, 0x61, 0x14, 0x01, 0x62, 0x40},
                "encode scoreTotal {a:10,b:32}");
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
    if (!gen::encode_by_name(rt, "span", argsV, w)) {
      std::printf("FAIL encode_by_name(span) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x10, 0x00, 0x02, 0x68, 0x69, 0x09}, "encode span {[\"hi\",-5]}");
  }

  // encode gauge {limit:300, offset:70000} → [cmd 17][ac 02][f0 a2 04] — uvar64
  {
    Object args(rt);
    args.setProperty(rt, "limit", 300.0);
    args.setProperty(rt, "offset", 70000.0);
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_name(rt, "gauge", argsV, w)) {
      std::printf("FAIL encode_by_name(gauge) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x11, 0x00, 0xac, 0x02, 0xf0, 0xa2, 0x04}, "encode gauge {300,70000}");
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

  // ── B1 decode contract: safe range → number, beyond → BigInt ──
  {
    // addNumbers output value=2^53+1 (zigzag 2^54+2) must restore as BigInt.
    // 2^54+2 = 0x40000000000002 → LEB128: 82 80 80 80 80 80 80 80 10... check:
    // value = 2^53+1 = 9007199254740993.
    uint8_t body[] = {0x82, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_name(rt, "addNumbers", r);
    Value value = result.getObject(rt).getProperty(rt, "value");
    if (!value.isBigInt()) {
      std::printf("FAIL decode addNumbers 2^53+1 must be BigInt\n"); ++g_failures;
    } else if (value.asBigInt(rt).asInt64(rt) != 9007199254740993LL) {
      std::printf("FAIL decode addNumbers 2^53+1 value\n"); ++g_failures;
    }
  }
  {
    // addNumbers output value=42 (zigzag 84) stays a number.
    uint8_t body[] = {0x54};
    rc::Reader r(body, 1);
    Value result = gen::decode_by_name(rt, "addNumbers", r);
    Value value = result.getObject(rt).getProperty(rt, "value");
    if (!value.isNumber() || value.asNumber() != 42.0) {
      std::printf("FAIL decode addNumbers 42 must stay number\n"); ++g_failures;
    }
  }
  {
    // gauge output next=u64::MAX (10-byte LEB128) must restore as BigInt.
    uint8_t body[] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_name(rt, "gauge", r);
    Value next = result.getObject(rt).getProperty(rt, "next");
    if (!next.isBigInt()) {
      std::printf("FAIL decode gauge u64::MAX must be BigInt\n"); ++g_failures;
    } else if (next.asBigInt(rt).asUint64(rt) != UINT64_MAX) {
      std::printf("FAIL decode gauge u64::MAX value\n"); ++g_failures;
    }
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

  // ── B1 wideAgg shared-fixture cross-check ────────────────────────────
  // examples/calculator/tests/wire_fixtures.rs 의 WIDEAGG_* hex 와
  // examples/calculator/ts/cross-wire.test.ts 의 대응 블록과 byte-exact.
  // 요청: Vec<u64> samples=[1,127,128,2^53+1,u64::MAX] + Some(i64::MIN).
  {
    Object args(rt);
    Array samples(rt, 5);
    samples.setValueAtIndex(rt, 0, 1.0);
    samples.setValueAtIndex(rt, 1, 127.0);
    samples.setValueAtIndex(rt, 2, 128.0);
    samples.setValueAtIndex(rt, 3, Value(rt, jsi::BigInt::fromUint64(rt, 9007199254740993ull)));
    samples.setValueAtIndex(rt, 4, Value(rt, jsi::BigInt::fromUint64(rt, UINT64_MAX)));
    args.setProperty(rt, "samples", samples);
    args.setProperty(rt, "offset", Value(rt, jsi::BigInt::fromInt64(rt, INT64_MIN)));
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_id(rt, 28, argsV, w)) {
      std::printf("FAIL encode_by_id(wideAgg=28) returned false\n");
      ++g_failures;
    }
    // == Rust/TS WIDEAGG_BOUNDARY_REQUEST "1c0005017f80018180808080808010…"
    check_bytes(w.take(),
                {0x1c, 0x00, 0x05, 0x01, 0x7f, 0x80, 0x01, 0x81, 0x80, 0x80, 0x80, 0x80,
                 0x80, 0x80, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                 0x01, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01},
                "shared-fixture encode wideAgg boundary");

    // 응답: max=u64::MAX, adjusted=i64::MIN+5 → 둘 다 BigInt 복원.
    // == WIDEAGG_BOUNDARY_RESPONSE 바디 "ffffffffffffffffff01 f5ffffffffffffffff01".
    uint8_t body[] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
                      0xf5, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_id(rt, 28, r);
    Object obj = result.getObject(rt);
    Value max = obj.getProperty(rt, "max");
    Value adjusted = obj.getProperty(rt, "adjusted");
    if (!max.isBigInt() || max.asBigInt(rt).asUint64(rt) != UINT64_MAX) {
      std::printf("FAIL decode wideAgg max u64::MAX\n"); ++g_failures;
    }
    if (!adjusted.isBigInt() || adjusted.asBigInt(rt).asInt64(rt) != (INT64_MIN + 5)) {
      std::printf("FAIL decode wideAgg adjusted i64::MIN+5\n"); ++g_failures;
    }
  }

  // 빈 벡터 + None → "1c000000" (WIDEAGG_EMPTY_REQUEST), 응답 00 00.
  {
    Object args(rt);
    Array samples(rt, 0);
    args.setProperty(rt, "samples", samples);
    args.setProperty(rt, "offset", Value::null());
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_id(rt, 28, argsV, w)) {
      std::printf("FAIL encode_by_id(wideAgg empty) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x1c, 0x00, 0x00, 0x00}, "shared-fixture encode wideAgg empty");

    uint8_t body[] = {0x00, 0x00};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_id(rt, 28, r);
    Object obj = result.getObject(rt);
    Value max = obj.getProperty(rt, "max");
    Value adjusted = obj.getProperty(rt, "adjusted");
    if (!max.isNumber() || max.asNumber() != 0.0) {
      std::printf("FAIL decode wideAgg empty max must be number 0\n"); ++g_failures;
    }
    if (!adjusted.isNumber() || adjusted.asNumber() != 0.0) {
      std::printf("FAIL decode wideAgg empty adjusted must be number 0\n"); ++g_failures;
    }
  }

  // 다원소 5/9/10바이트 varint (2^28, 2^35, 2^49) + Some(5)
  // → WIDEAGG_MULTIELEMENT_REQUEST "1c000380808080018080808080018080808080808001010a".
  {
    Object args(rt);
    Array samples(rt, 3);
    samples.setValueAtIndex(rt, 0, 268435456.0);          // 2^28
    samples.setValueAtIndex(rt, 1, 34359738368.0);        // 2^35
    samples.setValueAtIndex(rt, 2, 562949953421312.0);    // 2^49
    args.setProperty(rt, "samples", samples);
    args.setProperty(rt, "offset", 5.0);
    Value argsV(rt, args);
    rc::Writer w;
    if (!gen::encode_by_id(rt, 28, argsV, w)) {
      std::printf("FAIL encode_by_id(wideAgg multi) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(),
                {0x1c, 0x00, 0x03, 0x80, 0x80, 0x80, 0x80, 0x01, 0x80, 0x80, 0x80, 0x80,
                 0x80, 0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x01, 0x0a},
                "shared-fixture encode wideAgg multi");
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
  // 정적 코덱에 존재하는 greet 와 B1 이후 직결된 wideAgg 를 C++ 교차 검증한다.
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
    if (!gen::has_static_codec("addNumbers")) { std::printf("FAIL has_static_codec(addNumbers)\n"); ++g_failures; }
    if (!gen::has_static_codec("wideAgg")) { std::printf("FAIL has_static_codec(wideAgg)\n"); ++g_failures; }
    if (!gen::has_static_codec("echoGroups")) { std::printf("FAIL has_static_codec(echoGroups)\n"); ++g_failures; }
    if (!gen::has_static_codec("rustraRegistryDemo")) { std::printf("FAIL has_static_codec(rustraRegistryDemo)\n"); ++g_failures; }
    if (!gen::has_static_codec("tagSet")) { std::printf("FAIL has_static_codec(tagSet)\n"); ++g_failures; }
    if (gen::has_static_codec("dynamicCmd")) { std::printf("FAIL has_static_codec(dynamicCmd) should be false\n"); ++g_failures; }
  }

  // ── B2: native complex codec — Set(uniqueItems) ─────────────────
  // tagSet 은 Set<i64> 입력 / Set<string> 출력. TS complex-codec 계약과
  // 동일: encode 는 Set 이터레이션 순서 보존([...set] — 정렬/중복제거
  // 없음), decode 는 전역 Set 생성자로 복원(new Set(values)). Rust
  // BTreeSet 은 정렬 순서로 직렬화하지만 디코딩은 Set 이므로 순서 차이는
  // 관측되지 않는다. PINNED hex 는 wire_fixtures.rs TAGSET_* 와 짝이다.
  {
    // Set encode: new Set([-7, 1000, 15]) — 이터레이션 순서 그대로
    // [-7, 1000, 15] (Rust BTreeSet 의 정렬 순서와 다름이 의도).
    Object args(rt);
    Object setObj(rt);
    Array items(rt, 3);
    items.setValueAtIndex(rt, 0, -7.0);
    items.setValueAtIndex(rt, 1, 1000.0);
    items.setValueAtIndex(rt, 2, 15.0);
    // shim/실 JSI 모두 Set 은 Object — 전역 Set 으로 만든다(실 런타임 계약).
    Function setCtor = rt.global().getPropertyAsFunction(rt, "Set");
    {
      Value setArgs[] = {Value(rt, items)};
      setObj = setCtor.callAsConstructor(rt, setArgs, 1).getObject(rt);
    }
    args.setProperty(rt, "ids", setObj);
    Value argsV(rt, args);

    rc::Writer w;
    if (!gen::encode_by_name(rt, "tagSet", Value(rt, args), w)) {
      std::printf("FAIL encode_by_name(tagSet) returned false\n");
      ++g_failures;
    }
    // [cmd 26 LE][count 3][zigzag(-7)=13][zigzag(1000)=2000 LEB128 d0 0f][zigzag(15)=30]
    check_bytes(w.take(), {0x1d, 0x00, 0x03, 0x0d, 0xd0, 0x0f, 0x1e},
                "encode tagSet Set iteration order (no sort/dedup)");

    // 배열 입력도 TS 계약과 동일하게 허용된다.
    {
      Object arrArgs(rt);
      Array plain(rt, 2);
      plain.setValueAtIndex(rt, 0, 5.0);
      plain.setValueAtIndex(rt, 1, 5.0); // 중복 — C++ 는 중복제거하지 않는다
      arrArgs.setProperty(rt, "ids", plain);
      rc::Writer w2;
      gen::encode_by_name(rt, "tagSet", Value(rt, arrArgs), w2);
      check_bytes(w2.take(), {0x1d, 0x00, 0x02, 0x0a, 0x0a},
                  "encode tagSet array input keeps duplicates");
    }

    // Set decode: ["t-7","t1000","t15"] → 전역 Set 생성자 복원.
    // len: "t-7"=3, "t1000"=5, "t15"=3.
    uint8_t body[] = {0x03, 0x03, 't', '-', '7', 0x05, 't', '1', '0', '0', '0', 0x03, 't', '1', '5'};
    rc::Reader r(body, sizeof(body));
    Value result = gen::decode_by_name(rt, "tagSet", r);
    Object tags = result.getObject(rt).getProperty(rt, "tags").getObject(rt);
    bool isSet = tags.instanceOf(rt, rt.global().getPropertyAsFunction(rt, "Set"));
    Value sizeV = tags.getProperty(rt, "size");
    if (!isSet || !sizeV.isNumber() || sizeV.asNumber() != 3.0) {
      std::printf("FAIL decode tagSet must restore a real Set of size 3\n");
      ++g_failures;
    }
  }

  // ── encode_by_id / decode_by_id (P0-3: u16 디스패치) ──
  // by_name 과 동일한 per-command 함수를 재사용하므로 바이트/값이 완전히
  // 동일해야 한다 — switch 케이스가 잘못 매핑되면 즉시 드러난다.

  // (1) encode_by_id(addNumbers=1) — B1 이후 네이티브 코덱이 직접 처리.
  {
    Object args(rt);
    args.setProperty(rt, "a", 42.0);
    args.setProperty(rt, "b", 58.0);
    Value argsV(rt, args);
    rc::Writer w;
    bool ok = gen::encode_by_id(rt, 1, argsV, w);
    if (!ok) {
      std::printf("FAIL encode_by_id(1) returned false\n");
      ++g_failures;
    }
    check_bytes(w.take(), {0x01, 0x00, 0x54, 0x74}, "encode_by_id addNumbers {42,58}");
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
