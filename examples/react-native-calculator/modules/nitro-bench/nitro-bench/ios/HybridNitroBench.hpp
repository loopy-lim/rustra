#pragma once

#include "../nitrogen/generated/shared/c++/HybridNitroBenchSpec.hpp"

namespace margelo::nitro::nitrobench {

class HybridNitroBench: public HybridNitroBenchSpec {
public:
  HybridNitroBench(): HybridObject(TAG) {}

  double add(double a, double b) override;
  double echo(double value) override;
  std::string echoString(const std::string& value) override;
  std::shared_ptr<ArrayBuffer> echoBuffer(const std::shared_ptr<ArrayBuffer>& value) override;
  PairPayload echoPair(const PairPayload& value) override;
};

} // namespace margelo::nitro::nitrobench
