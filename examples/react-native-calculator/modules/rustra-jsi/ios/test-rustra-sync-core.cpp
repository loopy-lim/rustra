#include "rustra-sync-core.hpp"
#include "rustra-sync-contract.hpp"
#include <atomic>
#include <cassert>
#include <stdexcept>
#include <thread>

struct Core { int id; bool eligible; };
static void checkContractAdmission() {
  struct ContractCore { const char* hash; };
  ContractCore old{"old"}, changed{"changed"};
  int handlers = 0;
  auto invoke = [&](auto& binding, const ContractCore* core, const char* compiled, const char* js) {
    auto snapshot = binding.select(core, [&](const ContractCore* selected) {
      if (!rustra::syncContractsMatch(compiled, js, selected->hash))
        throw std::runtime_error("sync.unavailable");
      return 0;
    });
    assert(snapshot.core == core);
    ++handlers;
  };
  rustra::ValidatedSyncCore<ContractCore, int> original;
  invoke(original, &old, "old", "old");
  assert(handlers == 1);
  try { invoke(original, &changed, "old", "old"); assert(false); }
  catch (const std::runtime_error&) {}
  assert(handlers == 1);
  // New JS metadata and Rust agree, but the same command ID's compiled codec
  // still represents the old schema. A newly created binding must reject it.
  rustra::ValidatedSyncCore<ContractCore, int> rebound;
  try { invoke(rebound, &changed, "old", "changed"); assert(false); }
  catch (const std::runtime_error&) {}
  assert(handlers == 1);
  for (const char* missing : {static_cast<const char*>(nullptr), ""}) {
    rustra::ValidatedSyncCore<ContractCore, int> legacy;
    try { invoke(legacy, &old, missing, "old"); assert(false); }
    catch (const std::runtime_error&) {}
    assert(handlers == 1);
  }
  rustra::ValidatedSyncCore<ContractCore, int> rebuilt;
  invoke(rebuilt, &changed, "changed", "changed");
  assert(handlers == 2);
}

int main() {
  checkContractAdmission();
  Core old{1,true}, replacement{2,true}, denied{3,false};
  std::atomic<const Core*> current{&old};
  rustra::ValidatedSyncCore<Core,int> binding;
  int checks=0, calls=0;
  auto validate=[&](const Core* core) { ++checks; if(!core->eligible) throw std::runtime_error("sync.unavailable");return core->id; };
  auto first=binding.select(current.load(),validate);
  std::thread publisher([&]{current.store(&replacement);});publisher.join();
  // An in-flight operation retains the exact validated table through overflow/free.
  assert(first.core==&old&&first.metadata==1);
  ++calls;
  auto second=binding.select(current.load(),validate);
  assert(second.core==&replacement&&second.metadata==2);++calls;
  binding.select(current.load(),validate);assert(checks==2);
  current.store(&denied);
  try { binding.select(current.load(),validate);assert(false); } catch(const std::runtime_error&) {}
  assert(calls==2);
  // Failed validation is never cached; later calls still fail before a handler.
  try { binding.select(current.load(),validate);assert(false); } catch(const std::runtime_error&) {}
  assert(checks==4);
  // Nested validation can select another engine without contaminating the outer snapshot.
  rustra::ValidatedSyncCore<Core,int> nested;
  auto outer=nested.select(&old,[&](const Core* core){
    auto inner=nested.select(&replacement,validate);assert(inner.core==&replacement);
    return core->id;
  });
  assert(outer.core==&old&&outer.metadata==1);
}
