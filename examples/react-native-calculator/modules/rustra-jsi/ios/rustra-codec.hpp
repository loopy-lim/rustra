// rustra-codec.hpp — 순수 C++ postcard wire codec (JSI 무의존).
//
// Rust(rkyv V2 typed postcard handler) 와 바이트-동일한 postcard 인코딩/디코딩을
// 제공한다. codegen 이 생성하는 per-command codec(rustra-generated-codecs.cpp)이
// 이 Reader/Writer 를 사용해 JSI Value <-> postcard 바이트 변환을 수행한다.
//
// postcard 포맷 (Rust `postcard` crate 호환):
//   - unsigned varint(LEB128): 길이/카운트 및 부호화 정수의 베이스.
//   - 부호 정수(i64): zigzag → varint. (정확한 64-bit; 기존 TS codec 의 32-bit 절단 한계 제거)
//   - f64/f32: little-endian 고정폭.
//   - bool: 1바이트(0/1).
//   - String/bytes: varint 길이 + UTF-8/raw.
//
// 헤더 전용(inline) — 별도 .cpp 없이 단일 컴파일로 단위 테스트 가능.

#pragma once

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace rustra::codec {

// ── Writer ────────────────────────────────────────────────

/// postcard 바이트를 순차적으로 누적하는 라이터.
class Writer {
public:
  std::vector<uint8_t> buf;

  /// 누적된 바이트를 반환(이동).
  std::vector<uint8_t> take() { return std::move(buf); }

  void push_u8(uint8_t v) { buf.push_back(v); }

  /// 부호 없는 varint(LEB128). 길이/카운트용.
  void push_uvar(uint64_t n) {
    do {
      uint8_t b = static_cast<uint8_t>(n & 0x7f);
      n >>= 7;
      if (n != 0) b |= 0x80;
      buf.push_back(b);
    } while (n != 0);
  }

  /// 부호 있는 i64 → zigzag → varint. (정수 필드 공통)
  void push_i64(int64_t v) {
    uint64_t z = zigzag_encode(v);
    push_uvar(z);
  }

  /// f64 little-endian 고정폭.
  void push_f64(double v) {
    uint64_t bits;
    std::memcpy(&bits, &v, sizeof(bits));
    for (int i = 0; i < 8; ++i) buf.push_back(static_cast<uint8_t>(bits >> (8 * i)));
  }

  /// f32 little-endian 고정폭.
  void push_f32(float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, sizeof(bits));
    for (int i = 0; i < 4; ++i) buf.push_back(static_cast<uint8_t>(bits >> (8 * i)));
  }

  /// bool → 1바이트(0/1).
  void push_bool(bool v) { buf.push_back(v ? 1 : 0); }

  /// UTF-8 문자열: varint 길이 + 바이트.
  void push_string(const std::string& s) {
    push_uvar(s.size());
    buf.insert(buf.end(), s.begin(), s.end());
  }

  /// raw 바이트(길이 접두사 없음). 필요 시 호출측에서 길이 처리.
  void push_bytes(const uint8_t* data, size_t len) {
    buf.insert(buf.end(), data, data + len);
  }

private:
  /// i64 → uint64 zigzag. (n << 1) ^ (n >> 63), 산술 시프트.
  static uint64_t zigzag_encode(int64_t v) {
    return (static_cast<uint64_t>(v) << 1) ^ static_cast<uint64_t>(v >> 63);
  }
};

// ── Reader ────────────────────────────────────────────────

/// postcard 바이트에서 순차적으로 읽는 리더. 초과 읽기 시 runtime_error.
class Reader {
public:
  const uint8_t* data;
  size_t len;
  size_t pos;

  Reader(const uint8_t* d, size_t l) : data(d), len(l), pos(0) {}

  bool eof() const { return pos >= len; }

  uint8_t read_u8() {
    require(1);
    return data[pos++];
  }

  /// 부호 없는 varint(LEB128). 최대 10바이트(i64 범위).
  uint64_t read_uvar() {
    uint64_t value = 0;
    int shift = 0;
    for (int i = 0; i < 10; ++i) {
      require(1);
      uint8_t b = data[pos++];
      value |= static_cast<uint64_t>(b & 0x7f) << shift;
      if ((b & 0x80) == 0) return value;
      shift += 7;
    }
    throw std::runtime_error("postcard varint too long");
  }

  /// i64 (zigzag varint). JS Number(double) 호환 반환.
  int64_t read_i64() {
    uint64_t z = read_uvar();
    return zigzag_decode(z);
  }

  /// f64 little-endian.
  double read_f64() {
    require(8);
    uint64_t bits = 0;
    for (int i = 0; i < 8; ++i) bits |= static_cast<uint64_t>(data[pos + i]) << (8 * i);
    pos += 8;
    double v;
    std::memcpy(&v, &bits, sizeof(v));
    return v;
  }

  /// f32 little-endian.
  float read_f32() {
    require(4);
    uint32_t bits = 0;
    for (int i = 0; i < 4; ++i) bits |= static_cast<uint32_t>(data[pos + i]) << (8 * i);
    pos += 4;
    float v;
    std::memcpy(&v, &bits, sizeof(v));
    return v;
  }

  /// bool(1바이트, 0/1).
  bool read_bool() {
    uint8_t b = read_u8();
    return b != 0;
  }

  /// UTF-8 문자열: varint 길이 + 바이트.
  std::string read_string() {
    uint64_t n = read_uvar();
    if (n > (uint64_t)(len - pos)) throw std::runtime_error("postcard string length overflows");
    std::string s(reinterpret_cast<const char*>(data + pos), static_cast<size_t>(n));
    pos += static_cast<size_t>(n);
    return s;
  }

private:
  void require(size_t n) const {
    if (pos + n > len) throw std::runtime_error("postcard read past end");
  }

  /// uint64 zigzag → i64. (z >> 1) ^ -(z & 1).
  static int64_t zigzag_decode(uint64_t z) {
    return static_cast<int64_t>((z >> 1) ^ (0u - (z & 1u)));
  }
};

} // namespace rustra::codec
