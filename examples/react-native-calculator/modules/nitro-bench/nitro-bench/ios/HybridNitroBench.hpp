#pragma once
#include <mutex>
#include <optional>

#include "../nitrogen/generated/shared/c++/HybridNitroBenchSpec.hpp"

namespace margelo::nitro::nitrobench {

class HybridNitroBench: public HybridNitroBenchSpec {
public:
  HybridNitroBench(): HybridObject(TAG) {}

  double add(double a, double b) override;
  AddResult benchAdd(const AddPayload& value) override;
  StringPayload echoString(const StringPayload& value) override;
  BytesPayload echoBytes(const BytesPayload& value) override;
  BufferPayload echoBuffer(const BufferPayload& value) override;
  PairPayload echoPair(const PairPayload& value) override;
  ParityTree parityEcho(const ParityTree& value) override;
  ParitySearch parityFind(const ParityFindInput& value) override;
  ParityStored parityStore(const ParityTree& value) override;
  ParitySearch parityResident(const ParityQuery& value) override;
  ParitySearch parityIndexed(const ParityQuery& value) override;
  std::shared_ptr<Promise<AddResult>> benchAddAsync(const AddPayload& value) override { return Promise<AddResult>::resolved(benchAdd(value)); }
  std::shared_ptr<Promise<StringPayload>> echoStringAsync(const StringPayload& value) override { return Promise<StringPayload>::resolved(echoString(value)); }
  std::shared_ptr<Promise<PairPayload>> echoPairAsync(const PairPayload& value) override { return Promise<PairPayload>::resolved(echoPair(value)); }
  std::shared_ptr<Promise<BufferPayload>> echoBufferAsync(const BufferPayload& value) override { return Promise<BufferPayload>::resolved(echoBuffer(value)); }
  std::shared_ptr<Promise<ParityTree>> parityEchoAsync(const ParityTree& value) override { return Promise<ParityTree>::resolved(parityEcho(value)); }
  std::shared_ptr<Promise<ParitySearch>> parityFindAsync(const ParityFindInput& value) override { return Promise<ParitySearch>::resolved(parityFind(value)); }
  std::shared_ptr<Promise<ParityStored>> parityStoreAsync(const ParityTree& value) override { return Promise<ParityStored>::resolved(parityStore(value)); }
  std::shared_ptr<Promise<ParitySearch>> parityResidentAsync(const ParityQuery& value) override { return Promise<ParitySearch>::resolved(parityResident(value)); }
  std::shared_ptr<Promise<ParitySearch>> parityIndexedAsync(const ParityQuery& value) override { return Promise<ParitySearch>::resolved(parityIndexed(value)); }
private:
  std::mutex mutex_;
  std::optional<ParityTree> resident_;
  std::vector<std::optional<size_t>> index_;
};

} // namespace margelo::nitro::nitrobench
