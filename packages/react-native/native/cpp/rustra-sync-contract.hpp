#pragma once
#include <string_view>

namespace rustra {

// All three identities must agree before selecting a core for sync dispatch.
// Null/empty compiled identity denotes an older generated consumer.
inline bool syncContractsMatch(const char* compiled, std::string_view expected,
                               std::string_view native) {
  return compiled && !expected.empty() && expected == compiled && native == expected;
}

} // namespace rustra
