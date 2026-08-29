// test-rustra-codec.cpp — rustra-codec.hpp 단위 테스트 (JSI 무의존).
//
// 빌드/실행:
//   clang++ -std=c++17 -O2 -I<ios_dir> test-rustra-codec.cpp -o /tmp/test-rustra-codec && /tmp/test-rustra-codec
//
// 검증 전략:
//   1. known-value: 인코딩 결과가 Rust `postcard` crate 의 출력과 바이트-동일.
//   2. round-trip: encode → decode 로 값 보존.
//   3. 복합(요청/응답 와이어): addNumbers 요청/응답 바이트가 문서화된 rkyv V2 wire 와 일치.

#include "rustra-codec.hpp"

#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

using namespace rustra::codec;

static int g_failures = 0;

#define CHECK_EQ(actual, expected, msg)                                        \
  do {                                                                         \
    if ((actual) != (expected)) {                                              \
      std::printf("FAIL %s: got %lld, want %lld\n", (msg),                    \
                  (long long)(actual), (long long)(expected));                \
      ++g_failures;                                                            \
    }                                                                          \
  } while (0)

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
  // ── i64 known-value (Rust postcard 과 바이트-동일) ──
  {
    Writer w; w.push_i64(42);
    check_bytes(w.take(), {0x54}, "i64(42)");
  }
  {
    Writer w; w.push_i64(58);
    check_bytes(w.take(), {0x74}, "i64(58)");
  }
  {
    Writer w; w.push_i64(100);
    check_bytes(w.take(), {0xC8, 0x01}, "i64(100)");
  }
  {
    Writer w; w.push_i64(-1);
    check_bytes(w.take(), {0x01}, "i64(-1)");
  }
  {
    Writer w; w.push_i64(300);
    check_bytes(w.take(), {0xD8, 0x04}, "i64(300)");
  }

  // ── f64 known-value ──
  {
    Writer w; w.push_f64(1.5);
    check_bytes(w.take(), {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x3F}, "f64(1.5)");
  }

  // ── bool / string / vec ──
  {
    Writer w; w.push_bool(true);
    check_bytes(w.take(), {0x01}, "bool(true)");
  }
  {
    Writer w; w.push_string("hi");
    check_bytes(w.take(), {0x02, 0x68, 0x69}, "string(hi)");
  }
  {
    Writer w;
    w.push_uvar(2);      // vec 길이
    w.push_i64(10);
    w.push_i64(20);
    check_bytes(w.take(), {0x02, 0x14, 0x28}, "vec<i64>[10,20]");
  }

  // ── 복합 와이어: addNumbers 요청 [cmd_id u16 LE][postcard(a,b)] ──
  {
    Writer w;
    w.push_u8(1); w.push_u8(0); // cmd_id = 1 (addNumbers) LE
    w.push_i64(42);
    w.push_i64(58);
    check_bytes(w.take(), {0x01, 0x00, 0x54, 0x74}, "addNumbers request");
  }

  // ── 복합 와이어: addNumbers 응답 [ok=1][pad 7B][postcard(value=100)] ──
  {
    Writer w;
    w.push_u8(1);                              // ok
    w.push_bytes(nullptr, 0);                  // (placeholder)
    uint8_t pad[7] = {0,0,0,0,0,0,0};
    w.push_bytes(pad, 7);
    w.push_i64(100);
    auto got = w.take();
    std::vector<uint8_t> want = {0x01, 0,0,0,0,0,0,0, 0xC8, 0x01};
    check_bytes(got, want, "addNumbers response");
  }

  // ── round-trip: i64 (양수/음수/큰값) ──
  for (int64_t v : {(int64_t)0, (int64_t)42, (int64_t)-42, (int64_t)100,
                    (int64_t)-1, (int64_t)123456789, (int64_t)-987654321,
                    (int64_t)9007199254740991LL /* 2^53-1, JS 안전정수 최대 */}) {
    Writer w; w.push_i64(v);
    auto bytes = w.take();
    Reader r(bytes.data(), bytes.size());
    CHECK_EQ(r.read_i64(), v, "i64 round-trip");
  }

  // ── round-trip: f64 ──
  for (double v : {0.0, 1.5, -3.25, 3.14159, 1e9, -2.5e-5}) {
    Writer w; w.push_f64(v);
    auto bytes = w.take();
    Reader r(bytes.data(), bytes.size());
    double got = r.read_f64();
    if (got != v) {
      std::printf("FAIL f64 round-trip: got %f, want %f\n", got, v);
      ++g_failures;
    }
  }

  // ── round-trip: string (멀티바이트 UTF-8) ──
  for (const std::string& s : {std::string("hello"), std::string(""), std::string("안녕"),
                               std::string("🎉 emoji")}) {
    Writer w; w.push_string(s);
    auto bytes = w.take();
    Reader r(bytes.data(), bytes.size());
    std::string got = r.read_string();
    if (got != s) {
      std::printf("FAIL string round-trip: got <%s>, want <%s>\n", got.c_str(), s.c_str());
      ++g_failures;
    }
  }

  // ── round-trip: uvar (길이/카운트) ──
  for (uint64_t n : {(uint64_t)0, (uint64_t)1, (uint64_t)127, (uint64_t)128,
                     (uint64_t)16383, (uint64_t)16384, (uint64_t)1000000}) {
    Writer w; w.push_uvar(n);
    auto bytes = w.take();
    Reader r(bytes.data(), bytes.size());
    CHECK_EQ(r.read_uvar(), n, "uvar round-trip");
  }

  // ── overlong varint: 10바이트째 payload > 1 은 throw (postcard
  // max_of_last_byte = 2^(64%7)−1 = 1, TS _pcDecodeVarint64 계약과 동일) ──
  {
    // 2^64-1 + 2 → 마지막 바이트 0x03 (허용값 0x01 초과)
    uint8_t overlong[] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x03};
    Reader r(overlong, sizeof(overlong));
    bool threw = false;
    try {
      (void)r.read_uvar();
    } catch (const std::runtime_error&) {
      threw = true;
    }
    if (!threw) {
      std::printf("FAIL overlong varint must throw\n");
      ++g_failures;
    }
    // 경계값: 마지막 바이트 0x01 은 u64::MAX 와 동일하게 허용된다.
    uint8_t maxLegal[] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01};
    Reader rmax(maxLegal, sizeof(maxLegal));
    CHECK_EQ(rmax.read_uvar(), UINT64_MAX, "uvar 10-byte u64::MAX legal");
  }

  // ── 응답 디코더 시뮬레이션: ok 헤더 + postcard(value) ──
  {
    // addNumbers 응답 빌드 후 C++ codec 으로 value 복원
    Writer w;
    w.push_u8(1);
    uint8_t pad[7] = {0,0,0,0,0,0,0};
    w.push_bytes(pad, 7);
    w.push_i64(100);
    auto bytes = w.take();

    if (bytes.size() < 8 || bytes[0] != 1) {
      std::printf("FAIL response header check\n");
      ++g_failures;
    } else {
      Reader r(bytes.data() + 8, bytes.size() - 8);
      CHECK_EQ(r.read_i64(), 100, "response value decode");
    }
  }

  // ── 에러 와이어 디코드: [ok=0][pad to 8][err_len u16][err] ──
  {
    Writer w;
    w.push_u8(0);
    uint8_t pad[7] = {0,0,0,0,0,0,0};
    w.push_bytes(pad, 7);
    const std::string err = "boom";
    w.push_u8((uint8_t)(err.size() & 0xFF));
    w.push_u8((uint8_t)((err.size() >> 8) & 0xFF));
    w.push_bytes(reinterpret_cast<const uint8_t*>(err.data()), err.size());
    auto bytes = w.take();

    if (bytes[0] != 0) {
      std::printf("FAIL error ok flag\n");
      ++g_failures;
    } else {
      uint16_t elen = (uint16_t)bytes[8] | ((uint16_t)bytes[9] << 8);
      std::string msg(reinterpret_cast<const char*>(bytes.data() + 10), elen);
      if (msg != "boom") {
        std::printf("FAIL error msg: got <%s>\n", msg.c_str());
        ++g_failures;
      }
    }
  }

  if (g_failures == 0) {
    std::printf("OK: all rustra-codec tests passed\n");
    return 0;
  }
  std::printf("FAILED: %d check(s)\n", g_failures);
  return 1;
}
