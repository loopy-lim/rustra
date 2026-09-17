#include "HybridNitroBench.hpp"
#include <cmath>

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

namespace {
ParitySearch missing(double id, size_t visited) { return ParitySearch(false, id, "", static_cast<double>(visited)); }
ParitySearch search(const ParityTree& tree, double id) {
  std::vector<size_t> stack;
  if (!tree.nodes.empty()) stack.push_back(0);
  size_t visited = 0;
  while (!stack.empty()) {
    const auto position = stack.back(); stack.pop_back();
    if (position >= tree.nodes.size()) continue;
    const auto& node = tree.nodes[position]; ++visited;
    if (node.id == id) return ParitySearch(true, id, node.name, static_cast<double>(visited));
    for (auto child = node.children.rbegin(); child != node.children.rend(); ++child) stack.push_back(static_cast<size_t>(*child));
  }
  return missing(id, visited);
}
}
ParityTree HybridNitroBench::parityEcho(const ParityTree& value) { return value; }
ParitySearch HybridNitroBench::parityFind(const ParityFindInput& value) { return search(value.tree,value.id); }
ParityStored HybridNitroBench::parityStore(const ParityTree& value) {
  // Both competitors rebuild a dense ID -> position index on every replacement.
  std::vector<std::optional<size_t>> index(value.nodes.size());
  for (size_t p = 0; p < value.nodes.size(); ++p) {
    const auto id = value.nodes[p].id;
    if (id >= 0 && id < value.nodes.size() && std::floor(id) == id) index[static_cast<size_t>(id)] = p;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  resident_ = value; index_ = std::move(index);
  return ParityStored(static_cast<double>(value.nodes.size()));
}
ParitySearch HybridNitroBench::parityResident(const ParityQuery& value) {
  std::lock_guard<std::mutex> lock(mutex_);
  return resident_ ? search(*resident_,value.id) : missing(value.id,0);
}
ParitySearch HybridNitroBench::parityIndexed(const ParityQuery& value) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (resident_ && value.id >= 0 && value.id < index_.size() && std::floor(value.id) == value.id) {
    const auto position = index_[static_cast<size_t>(value.id)];
    if (position) return ParitySearch(true, value.id, resident_->nodes[*position].name, 1);
  }
  return missing(value.id,0);
}
} // namespace margelo::nitro::nitrobench
