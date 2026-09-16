// Actual Hermes + production bridge/codec. Only C ABI peers are controlled.
#include <hermes/hermes.h>
#include <jsi/instrumentation.h>
#include <jsi/decorator.h>
#include <cstdlib>
#include <iostream>
#include <functional>
#include <array>
#include <thread>
#include <optional>
#include "RustraJSIBridge.cpp"
#include "native-sync-ffi-stubs.inc"
#include "native-sync-peers.inc"

namespace native_test {
class CountingRuntime final : public jsi::RuntimeDecorator<> {
public:
  explicit CountingRuntime(jsi::Runtime& runtime) : RuntimeDecorator(runtime) {}
  size_t asciiNames = 0, asciiStrings = 0, utf8Strings = 0, utf8Names = 0;
  size_t globals = 0, nativeStates = 0;
  jsi::Object global() override { ++globals; return RuntimeDecorator::global(); }
  bool throwPressure = false, throwBufferCreation = false, throwResult = false;
  void setExternalMemoryPressure(const jsi::Object& object, size_t size) override {
    if (throwPressure) throw std::runtime_error("injected pressure failure");
    RuntimeDecorator::setExternalMemoryPressure(object, size);
  }
protected:
  bool hasNativeState(const jsi::Object& object) override {
    ++nativeStates; return RuntimeDecorator::hasNativeState(object);
  }
  std::shared_ptr<jsi::NativeState> getNativeState(const jsi::Object& object) override {
    ++nativeStates; return RuntimeDecorator::getNativeState(object);
  }
  void setNativeState(const jsi::Object& object, std::shared_ptr<jsi::NativeState> state) override {
    ++nativeStates; RuntimeDecorator::setNativeState(object, std::move(state));
  }
  jsi::ArrayBuffer createArrayBuffer(std::shared_ptr<jsi::MutableBuffer> buffer) override {
    if (throwBufferCreation) throw std::runtime_error("injected ArrayBuffer creation failure");
    return RuntimeDecorator::createArrayBuffer(std::move(buffer));
  }
  void setPropertyValue(const jsi::Object& object, const jsi::PropNameID& name, const jsi::Value& value) override {
    if (throwResult && name.utf8(*this) == "data") throw std::runtime_error("injected result decoding failure");
    RuntimeDecorator::setPropertyValue(object, name, value);
  }
  jsi::PropNameID createPropNameIDFromUtf8(const uint8_t* value, size_t size) override {
    ++utf8Names; return RuntimeDecorator::createPropNameIDFromUtf8(value, size);
  }
  jsi::PropNameID createPropNameIDFromAscii(const char* value, size_t size) override {
    ++asciiNames; return RuntimeDecorator::createPropNameIDFromAscii(value, size);
  }
  jsi::String createStringFromAscii(const char* value, size_t size) override {
    ++asciiStrings; return RuntimeDecorator::createStringFromAscii(value, size);
  }
  jsi::String createStringFromUtf8(const uint8_t* value, size_t size) override {
    ++utf8Strings; return RuntimeDecorator::createStringFromUtf8(value, size);
  }
};
static int failures = 0, assertions = 0;
static void check(bool ok, const std::string& message) {
  ++assertions;
  if (!ok) throw std::runtime_error(message);
}
static jsi::Value evaluate(jsi::Runtime& rt, const std::string& source) {
  return rt.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(source), "native-sync-test.js");
}
static void run(jsi::Runtime& rt, const char* name, const std::string& source) {
  try {
    publish(0); for (auto& p : peers) { p.mode = 0; p.duringFrame = {}; }
    evaluate(rt, "(()=>{" + source + "})()");
    check(allocationErrors == 0, "wrong owner/length/double free");
    std::cout << "PASS " << name << '\n';
  } catch (const std::exception& error) {
    ++failures; std::cerr << "FAIL " << name << ": " << error.what() << '\n';
  }
}
template<typename Fn> static void host(jsi::Runtime& rt, const char* name, unsigned count, Fn fn) {
  auto id = jsi::PropNameID::forAscii(rt, name);
  rt.global().setProperty(rt, id, jsi::Function::createFromHostFunction(rt, id, count, fn));
}
static void installTestAPI(jsi::Runtime& rt) {
  rustra::RustraHostObject factory(rt);
  rt.global().setProperty(rt, "__bind", factory.getFunction(rt, jsi::PropNameID::forAscii(rt, "bindSyncCommand")));
  rt.global().setProperty(rt, "__hash", jsi::String::createFromAscii(rt, rustra::generated::compiled_contract_hash()));
  host(rt, "publish", 1, [](auto&, const auto&, const auto* a, size_t) { publish(static_cast<int>(a[0].asNumber())); return jsi::Value(); });
  host(rt, "assert", 2, [](auto& r, const auto&, const auto* a, size_t n) {
    check(a[0].getBool(), n > 1 ? a[1].asString(r).utf8(r) : "JS assertion"); return jsi::Value();
  });
  host(rt, "mode", 2, [](auto&, const auto&, const auto* a, size_t) { peers[static_cast<int>(a[0].asNumber())].mode = static_cast<int>(a[1].asNumber()); return jsi::Value(); });
  host(rt, "stat", 2, [](auto& r, const auto&, const auto* a, size_t) {
    auto& p = peers[static_cast<int>(a[0].asNumber())]; auto key = a[1].asString(r).utf8(r);
    const int value = key == "hashes" ? p.hashes : key == "schemas" ? p.schemas : key == "frames" ? p.frames : key == "raws" ? p.raws : key == "buffers" ? p.buffers : key == "ownedFrees" ? p.ownedFrees : p.frees;
    return jsi::Value(value);
  });
  host(rt, "collect", 0, [](auto& r, const auto&, const auto*, size_t) { r.instrumentation().collectGarbage("native-sync-test"); return jsi::Value(); });
  host(rt, "externalBytes", 0, [](auto& r, const auto&, const auto*, size_t) {
    const auto info = r.instrumentation().getHeapInfo(false);
    auto found = info.find("hermes_externalBytes");
    check(found != info.end(), "Hermes external byte counter unavailable");
    return jsi::Value(static_cast<double>(found->second));
  });
  host(rt, "checkConversionWork", 1, [](auto& r, const auto&, const auto* a, size_t) {
    auto input = evaluate(r, "({nodes:Array.from({length:64},()=>node({owner:'a',kind:'b'}))})");
    CountingRuntime counted(r); rustra::codec::Writer writer;
    check(rustra::generated::encode_by_id(counted, 34, input, writer), "arena codec missing");
    if (a[0].asNumber() == 0) check(counted.utf8Strings == 0, "map encode recreated UTF8 keys");
    else if (a[0].asNumber() == 1) check(counted.asciiNames + counted.asciiStrings <= 8, "fixed property resolution scales with node count");
    if (a[0].asNumber() == 3) {
      check(counted.globals == 0 && counted.nativeStates == 0, "encode accessed cross-invocation property state");
      check(counted.asciiNames == 7 && counted.asciiStrings == 0, "encode did not own exactly its finite names");
    }
    counted.globals = counted.nativeStates = counted.asciiNames = 0;
    rustra::codec::Reader reader(writer.data() + 2, writer.size() - 2);
    auto result = rustra::generated::decode_by_id(counted, 34, reader);
    if (a[0].asNumber() == 4) {
      check(counted.globals == 0 && counted.nativeStates == 0, "decode accessed cross-invocation property state");
      check(counted.asciiNames == 7, "decode did not own exactly its finite names");
    }
    if (a[0].asNumber() == 2) check(counted.utf8Names == 128, "dynamic map output keys did not use named properties");
    check(result.asObject(r).getPropertyAsObject(r, "nodes").asArray(r).size(r) == 64, "counted codec result");
    return jsi::Value();
  });
  host(rt, "checkResultPropertyState", 1, [](auto& r, const auto&, const auto* a, size_t) {
    auto input = evaluate(r, "new ArrayBuffer(3)");
    CountingRuntime counted(r); jsi::Value result;
    if (a[0].getBool()) {
      result = rustra::generated::decode_buffer_result_by_id(counted, 25, jsi::Value(r, input));
      check(result.asObject(r).getPropertyAsObject(r, "data").getArrayBuffer(r).size(r) == 3, "buffer result changed");
    } else {
      double value = 42; uint64_t slot; std::memcpy(&slot, &value, sizeof(slot));
      result = rustra::generated::decode_raw_result(counted, 23, slot);
      check(result.asObject(r).getProperty(r, "value").asNumber() == 42, "raw result changed");
    }
    check(counted.globals == 0 && counted.nativeStates == 0, "result accessed cross-invocation property state");
    check(counted.asciiNames == 1, "result did not own its one actual property name");
    return jsi::Value();
  });
  host(rt, "checkPressureFailure", 0, [](auto& r, const auto&, const auto*, size_t) {
    auto input = evaluate(r, "new Uint8Array([1,2,3]).buffer");
    for (int boundary = 0; boundary < 3; ++boundary) {
      CountingRuntime counted(r);
      counted.throwPressure = boundary == 0;
      counted.throwBufferCreation = boundary == 1;
      counted.throwResult = boundary == 2;
      auto before = peers[0].ownedFrees, dispatched = peers[0].buffers; bool threw = false;
      try { rustra::invokeBufferOnCore(counted, &tables[0], 25, input); }
      catch (const std::exception&) { threw = true; }
      publish(1); r.instrumentation().collectGarbage("owned-output-exception");
      check(threw, "owned output failure injection was bypassed");
      check(peers[0].buffers == dispatched + 1, "owned output exception retried handler");
      check(peers[0].ownedFrees == before + 1, "owned output exception lost producing owner");
    }
    return jsi::Value();
  });
  host(rt, "duringFrame", 1, [](auto& r, const auto&, const auto* a, size_t) {
    auto f = std::make_shared<jsi::Function>(a[0].asObject(r).asFunction(r));
    peers[0].duringFrame = [&r, f] { f->call(r); }; return jsi::Value();
  });
  host(rt, "encodedHex", 2, [](auto& r, const auto&, const auto* a, size_t) {
    rustra::codec::Writer writer;
    check(rustra::generated::encode_by_id(r, static_cast<uint16_t>(a[0].asNumber()), a[1], writer), "codec unavailable");
    static constexpr char digits[] = "0123456789abcdef"; std::string result;
    for (size_t i = 0; i < writer.size(); ++i) { result += digits[writer.data()[i] >> 4]; result += digits[writer.data()[i] & 15]; }
    return jsi::String::createFromUtf8(r, result);
  });
  evaluate(rt, R"JS(
    globalThis.bind = (id,name,route=0) => __bind(id,name,__hash,route);
    globalThis.rejects = f => { let caught=false; try { f(); } catch(e) { caught=true; } assert(caught,"expected rejection"); };
    globalThis.node = (metadata={},note=null) => ({id:1,name:"node",tag:"folder",note,metadata,children:[]});
  )JS");
}
static void binderTests(jsi::Runtime& rt) {
  run(rt, "admission rejects before dispatch and frees metadata", R"JS(
    for(const p of [2,3,4,5,6,7,9,10,11]) {
      publish(p); const calls=stat(p,"frames")+stat(p,"raws");
      rejects(()=>bind(23,"benchAdd",2)); rejects(()=>bind(23,"benchAdd",2));
      assert(stat(p,"frames")+stat(p,"raws")===calls,"rejected peer dispatched");
      assert(stat(p,"frees")===stat(p,"hashes")+stat(p,"schemas"),"metadata release");
    }
    publish(0); rejects(()=>__bind(23,"benchAdd","wrong",2));
    rejects(()=>bind(65535,"unknown")); rejects(()=>bind(23,"benchAdd",5));
    rejects(()=>__bind(23,"benchAdd",__hash));
  )JS");
  run(rt, "compiled identity rejects matching foreign JS and core", R"JS(
    publish(2); rejects(()=>__bind(23,"benchAdd","different",2));
  )JS");
  run(rt, "raw success, unavailable fallback, error exactly once", R"JS(
    const f=bind(23,"benchAdd",2), obj={a:42,b:58};
    assert(f(obj,42,58).value===100); let raw=stat(0,"raws"), frame=stat(0,"frames");
    mode(0,4); assert(f(obj,42,58).value===100);
    assert(stat(0,"raws")===raw+1 && stat(0,"frames")===frame+1);
    mode(0,1); raw=stat(0,"raws"); frame=stat(0,"frames"); rejects(()=>f(obj,42,58));
    assert(stat(0,"raws")===raw+1 && stat(0,"frames")===frame,"raw error retried");
    rejects(()=>f(obj,42));
  )JS");
  run(rt, "core change between bind and call revalidates", R"JS(
    const f=bind(23,"benchAdd",2); const h=stat(0,"hashes");
    assert(f({},1,2).value===3); assert(stat(0,"hashes")===h,"stable table revalidated");
    publish(1); assert(f({},1,2).value===1003);
    publish(3); const old=stat(3,"hashes"); rejects(()=>f({},1,2)); rejects(()=>f({},1,2));
    assert(stat(3,"hashes")===old+2,"failure cached");
  )JS");
  run(rt, "getter reentry retains outer validated core", R"JS(
    const f=bind(23,"benchAdd"); let reads=0, inner;
    const input={get a(){reads++; publish(1); inner=f({a:2,b:3}); return 4;},b:5};
    const outer=f(input); assert(reads===1 && inner.value===1005 && outer.value===9,"snapshot contaminated");
  )JS");
  run(rt, "native reentry and overflow retry retain owner", R"JS(
    const f=bind(24,"benchEchoString"); let inner;
    duringFrame(()=>{publish(1); inner=f({value:"inner"});});
    const before=stat(0,"frames"), b=stat(1,"frames"), text="x".repeat(1024);
    assert(f({value:text}).value===text && inner.value==="inner");
    assert(stat(0,"frames")===before+2 && stat(1,"frames")===b+1,"overflow switched owner");
  )JS");
  run(rt, "frame errors and malformed responses never retry", R"JS(
    const f=bind(23,"benchAdd");
    for(const m of [1,2,3]) { mode(0,m); const before=stat(0,"frames"); rejects(()=>f({a:1,b:2})); assert(stat(0,"frames")===before+1); }
  )JS");
}

#include "native-sync-codec-tests.inc"
#include "native-sync-runtime-tests.inc"
}

int main() {
  using namespace native_test;
  initializePeers();
  for (int generation = 0; generation < 2; ++generation) {
    auto runtime = facebook::hermes::makeHermesRuntime();
    std::cout << "Runtime " << generation << " at " << runtime.get() << '\n';
    publish(0); installTestAPI(*runtime);
    if (generation == 0) binderTests(*runtime);
    codecTests(*runtime);
    for (auto& p : peers) p.duringFrame = {};
    runtime->instrumentation().collectGarbage("native-sync-test-final");
    runtime.reset();
  }
  runtimeIsolationTests();
  runtimeDecoratorReuseTest();
  if (!live.empty() || allocationErrors) { ++failures; std::cerr << "FAIL allocation ledger: " << live.size() << " live, " << allocationErrors << " errors\n"; }
  std::cout << "NATIVE_SYNC_RESULT assertions=" << assertions << " failures=" << failures << "\n";
  return failures ? 1 : 0;
}
