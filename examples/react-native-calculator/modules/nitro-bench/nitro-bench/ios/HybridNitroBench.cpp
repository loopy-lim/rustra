#include "HybridNitroBench.hpp"

// ArrayBuffer 은 spec 헤더(HybridNitroBenchSpec.hpp)가 이미 include 한다.

namespace margelo::nitro::nitrobench {

double HybridNitroBench::add(double a, double b) {
  return a + b;
}

double HybridNitroBench::echo(double value) {
  return value;
}

std::string HybridNitroBench::echoString(const std::string& value) {
  return value;
}

std::shared_ptr<ArrayBuffer> HybridNitroBench::echoBuffer(const std::shared_ptr<ArrayBuffer>& value) {
  // 왕복 — copy 팩토리로 새 버퍼 할당+복사(입력 재사용 금지, 실 마셜링 비용 측정).
  return ArrayBuffer::copy(value->data(), value->size());
}

PairPayload HybridNitroBench::echoPair(const PairPayload& value) {
  return value;
}

} // namespace margelo::nitro::nitrobench
