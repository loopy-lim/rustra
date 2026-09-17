#pragma once

namespace rustra {

// Used on the JS runtime thread. Published CoreTables are immutable and never
// unloaded. Every caller owns a snapshot by value, including nested invocations.
// A new pointer must validate before dispatch; failed validation is never cached.
template <typename Core, typename Metadata>
class ValidatedSyncCore {
public:
  struct Snapshot { const Core* core; Metadata metadata; };

  template <typename Validate>
  Snapshot select(const Core* current, Validate validate) {
    if (current == cached_.core) return cached_;
    auto metadata = validate(current);
    Snapshot snapshot{current, metadata};
    cached_ = snapshot;
    return snapshot;
  }

private:
  Snapshot cached_{nullptr, {}};
};

} // namespace rustra
