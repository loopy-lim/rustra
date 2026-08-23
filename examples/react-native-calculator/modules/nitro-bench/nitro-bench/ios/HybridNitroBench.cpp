#include "HybridNitroBench.hpp"

// ArrayBuffer 은 spec 헤더(HybridNitroBenchSpec.hpp)가 이미 include 한다.

namespace margelo::nitro::nitrobench {

double HybridNitroBench::add(double a, double b) {
  return a + b;
}

AddResult HybridNitroBench::benchAdd(const AddPayload& value) {
  return AddResult(value.a + value.b);
}

StringPayload HybridNitroBench::echoString(const StringPayload& value) {
  return value;
}

BytesPayload HybridNitroBench::echoBytes(const BytesPayload& value) {
  return value;
}

BufferPayload HybridNitroBench::echoBuffer(const BufferPayload& value) {
  // Match Rustra's ownership boundary: the returned buffer owns a fresh copy.
  return BufferPayload(margelo::nitro::ArrayBuffer::copy(value.data));
}

PairPayload HybridNitroBench::echoPair(const PairPayload& value) {
  return value;
}

} // namespace margelo::nitro::nitrobench
