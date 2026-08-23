#pragma once

#include "../nitrogen/generated/shared/c++/HybridNitroBenchSpec.hpp"

namespace margelo::nitro::nitrobench {

class HybridNitroBench: public HybridNitroBenchSpec {
public:
  HybridNitroBench(): HybridObject(TAG) {}

  double add(double a, double b) override;
  AddResult benchAdd(const AddPayload& value) override;
  StringPayload echoString(const StringPayload& value) override;
  BytesPayload echoBytes(const BytesPayload& value) override;
  PairPayload echoPair(const PairPayload& value) override;
};

} // namespace margelo::nitro::nitrobench
