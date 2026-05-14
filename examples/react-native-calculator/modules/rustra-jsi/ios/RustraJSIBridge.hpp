#pragma once

#include <jsi/jsi.h>
#include <memory>
#include <string>

namespace rustra {

extern "C" {
  uint8_t* rustra_calculator_invoke_bytes(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  void rustra_calculator_free_buffer(uint8_t* ptr, size_t len);
}

class RustraHostObject : public facebook::jsi::HostObject {
public:
  facebook::jsi::Value get(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::PropNameID& name) override;

  void set(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::PropNameID& name,
    const facebook::jsi::Value& value) override {}

  std::vector<facebook::jsi::PropNameID> getPropertyNames(
    facebook::jsi::Runtime& rt) override;
};

void installRustraJSI(facebook::jsi::Runtime& rt);

} // namespace rustra
