// Real Hermes/production dispatchers with independent core-local IDs.
namespace lifecycle {
class Invoker final : public facebook::react::CallInvoker {
public:
  std::deque<facebook::react::CallFunc> queued;
  void invokeAsync(facebook::react::CallFunc&& call) noexcept override {
    queued.push_back(std::move(call));
  }
  void invokeSync(facebook::react::CallFunc&&) override {
    throw std::runtime_error("unexpected synchronous invocation");
  }
  void drain(jsi::Runtime& rt) {
    while (!queued.empty()) {
      auto call = std::move(queued.front()); queued.pop_front(); call(rt);
    }
  }
};
struct Pending {
  void* data;
  uint8_t* buffer;
  rustra::rustra_async_into_callback_t complete;
};
struct Peer {
  std::vector<Pending> pending;
  std::vector<uint64_t> cancelled;
  int drops = 0;
  rustra::rustra_channel_callback_t json = nullptr;
  rustra::rustra_channel_bytes_callback_t bytes = nullptr;
  void* channelData = nullptr;
};
static Peer owners[2];
template<int I> static void start(const uint8_t*, size_t, uint8_t* buffer, size_t,
  void* data, rustra::rustra_async_into_callback_t complete, uint64_t* id) {
  *id = 7; owners[I].pending.push_back({data, buffer, complete});
}
template<int I> static bool cancel(uint64_t id) {
  owners[I].cancelled.push_back(id); return id == 7;
}
template<int I> static uint32_t create(rustra::rustra_channel_callback_t cb, void* data) {
  owners[I].json = cb; owners[I].channelData = data; return 1;
}
template<int I> static uint32_t createBytes(rustra::rustra_channel_bytes_callback_t cb, void* data) {
  owners[I].bytes = cb; owners[I].channelData = data; return 1;
}
template<int I> static int32_t drop(uint32_t handle) {
  if (handle != 1 || (!owners[I].json && !owners[I].bytes)) return 0;
  ++owners[I].drops; owners[I].json = nullptr; owners[I].bytes = nullptr; return 1;
}
template<int I> static void prepare() {
  tables[I].invoke_frame_async_into = start<I>;
  tables[I].invoke_cancel = cancel<I>;
  tables[I].channel_create = create<I>;
  tables[I].channel_create_bytes = createBytes<I>;
  tables[I].channel_drop = drop<I>;
}
static void finishAsync() {
  for (auto& owner : owners) {
    for (auto& call : owner.pending) call.complete(call.data, call.buffer, 0, 0);
    owner.pending.clear();
  }
}
static jsi::Function callback(jsi::Runtime& rt, int& calls) {
  auto name = jsi::PropNameID::forAscii(rt, "lifecycleCallback");
  return jsi::Function::createFromHostFunction(rt, name, 1,
    [&calls](auto&, const auto&, const auto*, size_t) { ++calls; return jsi::Value(); });
}
template<typename Test> static void run(jsi::Runtime& rt, const char* name, Test test) {
  const Table original0 = tables[0], original1 = tables[1];
  owners[0] = {}; owners[1] = {}; prepare<0>(); prepare<1>(); publish(0);
  auto invoker = std::make_shared<Invoker>();
  rustra::getEventDispatcher()->setCallInvoker(invoker);
  rustra::getChannelDispatcher()->setCallInvoker(invoker);
  try { test(invoker); std::cout << "PASS " << name << '\n'; }
  catch (const std::exception& error) {
    ++failures; std::cerr << "FAIL " << name << ": " << error.what() << '\n';
  }
  rustra::invalidateRustraJSI(); finishAsync(); invoker->drain(rt);
  rustra::getChannelDispatcher()->setCallInvoker(nullptr);
  rustra::getEventDispatcher()->setCallInvoker(nullptr);
  tables[0] = original0; tables[1] = original1; publish(0);
}
static double startAsync(jsi::Runtime& rt, rustra::RustraHostObject& factory, bool byId,
  jsi::Function& success, jsi::Function& error) {
  auto args = evaluate(rt, "({a:1,b:2})");
  auto fn = factory.getFunction(rt, jsi::PropNameID::forAscii(rt,
    byId ? "invokeTypedAsyncById" : "invokeTypedAsync"));
  if (byId) return fn.call(rt, 23, args, success, error).asNumber();
  return fn.call(rt, "benchAdd", args, success, error).asNumber();
}
static void tests(jsi::Runtime& rt) {
  run(rt, "runtime invalidation retires queued channel callbacks", [&](auto& invoker) {
    int calls = 0; auto dispatcher = rustra::getChannelDispatcher();
    dispatcher->create(rt, callback(rt, calls));
    owners[0].json(owners[0].channelData, 1, "queued");
    rustra::invalidateRustraJSI();
    invoker->drain(rt);
    check(calls == 0, "invalidated runtime still receives queued channel callback");
    check(owners[0].drops == 1, "invalidated runtime retains producing core channel");
  });
  run(rt, "runtime invalidation retires queued event listeners", [&](auto& invoker) {
    int calls = 0; auto dispatcher = rustra::getEventDispatcher();
    tables[0].event_sink_register = [](rustra::rustra_event_callback_t, void*) {};
    tables[0].event_sink_unregister = []() {};
    dispatcher->setListener(rt, "teardown", callback(rt, calls));
    rustra::EventDispatcher::onRustEvent(dispatcher.get(), "teardown", "queued");
    rustra::invalidateRustraJSI();
    invoker->drain(rt);
    check(calls == 0, "invalidated runtime still receives queued event callback");
  });
  run(rt, "in-flight channel callback during producer drop leaves no retired queue", [&](auto& invoker) {
    int calls = 0; auto dispatcher = rustra::getChannelDispatcher();
    dispatcher->create(rt, callback(rt, calls));
    tables[0].channel_drop = [](uint32_t handle) {
      if (owners[0].json) owners[0].json(owners[0].channelData, handle, "during drop");
      return drop<0>(handle);
    };
    rustra::invalidateRustraJSI();
    check(dispatcher->pendingCount() == 0, "producer drop left a retired channel payload queued");
    invoker->drain(rt); check(calls == 0, "producer drop called an invalidated listener");
  });
  run(rt, "in-flight event callback during sink removal leaves no retired queue", [&](auto& invoker) {
    int calls = 0; auto dispatcher = rustra::getEventDispatcher();
    tables[0].event_sink_register = [](rustra::rustra_event_callback_t, void*) {};
    tables[0].event_sink_unregister = []() {
      rustra::EventDispatcher::onRustEvent(rustra::getEventDispatcher().get(), "teardown", "late");
    };
    dispatcher->setListener(rt, "teardown", callback(rt, calls));
    rustra::invalidateRustraJSI();
    check(dispatcher->pendingCount() == 0, "sink removal left a retired event queued");
    invoker->drain(rt); check(calls == 0, "sink removal called an invalidated listener");
  });
  run(rt, "bound close preserves a later registration from the same producing core", [&](auto&) {
    int calls = 0; auto dispatcher = rustra::getChannelDispatcher();
    dispatcher->create(rt, callback(rt, calls)); auto closeOld = dispatcher->bindClose(rt, 1);
    dispatcher->drop(1); dispatcher->create(rt, callback(rt, calls));
    check(!closeOld.call(rt).getBool(), "retired close released a reused producer handle");
    check(owners[0].drops == 1, "retired close dropped the replacement registration");
  });
  run(rt, "retired event invoker cannot drain replacement runtime listeners", [&](auto& oldInvoker) {
    auto dispatcher = rustra::getEventDispatcher(); int oldCalls = 0, newCalls = 0;
    tables[0].event_sink_register = [](rustra::rustra_event_callback_t, void*) {};
    tables[0].event_sink_unregister = []() {};
    dispatcher->setListener(rt, "generation", callback(rt, oldCalls));
    rustra::EventDispatcher::onRustEvent(dispatcher.get(), "generation", "old");
    rustra::invalidateRustraJSI();
    auto nextInvoker = std::make_shared<Invoker>(); dispatcher->setCallInvoker(nextInvoker);
    dispatcher->setListener(rt, "generation", callback(rt, newCalls));
    rustra::EventDispatcher::onRustEvent(dispatcher.get(), "generation", "new");
    oldInvoker->drain(rt);
    check(newCalls == 0, "retired event invoker entered replacement callback");
    nextInvoker->drain(rt);
    check(newCalls == 1 && oldCalls == 0, "replacement event invoker lost its own delivery");
  });
  run(rt, "retired channel invoker cannot drain replacement runtime callbacks", [&](auto& oldInvoker) {
    auto dispatcher = rustra::getChannelDispatcher(); int oldCalls = 0, newCalls = 0;
    dispatcher->create(rt, callback(rt, oldCalls));
    owners[0].json(owners[0].channelData, 1, "old"); rustra::invalidateRustraJSI();
    auto nextInvoker = std::make_shared<Invoker>(); dispatcher->setCallInvoker(nextInvoker);
    dispatcher->create(rt, callback(rt, newCalls));
    owners[0].json(owners[0].channelData, 1, "new"); oldInvoker->drain(rt);
    check(newCalls == 0, "retired channel invoker entered replacement callback");
    nextInvoker->drain(rt);
    check(newCalls == 1 && oldCalls == 0, "replacement channel invoker lost its own delivery");
  });
  run(rt, "runtime invalidation cancels each producing core", [&](auto&) {
    int delivered = 0; auto success = callback(rt, delivered), error = callback(rt, delivered);
    rustra::RustraHostObject factory(rt);
    startAsync(rt, factory, false, success, error); publish(1);
    startAsync(rt, factory, true, success, error);
    rustra::invalidateRustraJSI();
    check(owners[0].cancelled == std::vector<uint64_t>{7}, "old core invocation was not cancelled");
    check(owners[1].cancelled == std::vector<uint64_t>{7}, "new core received a stale cancellation");
    finishAsync(); check(delivered == 0, "invalid runtime received a callback");
  });
  run(rt, "public async handles remain distinct across core-local collisions", [&](auto&) {
    int delivered = 0; auto success = callback(rt, delivered), error = callback(rt, delivered);
    rustra::RustraHostObject factory(rt);
    auto oldId = startAsync(rt, factory, false, success, error); publish(1);
    auto newId = startAsync(rt, factory, true, success, error);
    check(oldId != newId, "two independent core calls share a public cancellation handle");
    auto cancelFn = factory.getFunction(rt, jsi::PropNameID::forAscii(rt, "invokeCancel"));
    check(cancelFn.call(rt, oldId).getBool(), "old invocation cancellation failed");
    check(owners[0].cancelled == std::vector<uint64_t>{7} && owners[1].cancelled.empty(), "cancel crossed cores");
    check(cancelFn.call(rt, newId).getBool(), "new invocation cancellation failed");
    check(owners[1].cancelled == std::vector<uint64_t>{7}, "new invocation cancellation missed its core");
  });
  run(rt, "new JSON channel retires old owner and queued frames before drain", [&](auto& invoker) {
    auto dispatcher = rustra::getChannelDispatcher(); int oldCalls = 0, newCalls = 0;
    dispatcher->create(rt, callback(rt, oldCalls));
    owners[0].json(owners[0].channelData, 1, "old"); publish(1);
    dispatcher->requestResetAfterSwap();
    dispatcher->create(rt, callback(rt, newCalls));
    owners[1].json(owners[1].channelData, 1, "new"); invoker->drain(rt);
    check(owners[0].drops == 1, "old channel owner was overwritten without release");
    check(oldCalls == 0 && newCalls == 1, "old queued frame reached replacement channel");
    check(owners[1].drops == 0, "new channel was retired with the old owner");
  });
  run(rt, "new bytes channel rejects queued frames from a retired owner", [&](auto& invoker) {
    auto dispatcher = rustra::getChannelDispatcher(); int oldCalls = 0, newCalls = 0;
    const uint8_t bytes[] = {1, 2}; dispatcher->createBytes(rt, callback(rt, oldCalls));
    owners[0].bytes(owners[0].channelData, 1, bytes, 2); publish(1);
    dispatcher->requestResetAfterSwap(); dispatcher->createBytes(rt, callback(rt, newCalls));
    owners[1].bytes(owners[1].channelData, 1, bytes, 2); invoker->drain(rt);
    check(owners[0].drops == 1 && oldCalls == 0 && newCalls == 1, "binary owner/queued frame collision");
  });
  run(rt, "bound close of retired channel preserves replacement owner", [&](auto& invoker) {
    int oldCalls = 0, newCalls = 0; rustra::RustraHostObject factory(rt);
    auto createFn = factory.getFunction(rt, jsi::PropNameID::forAscii(rt, "createChannel"));
    auto oldCallback = callback(rt, oldCalls), newCallback = callback(rt, newCalls);
    auto oldHandle = createFn.call(rt, oldCallback);
    auto bindClose = factory.getFunction(rt, jsi::PropNameID::forAscii(rt, "bindChannelClose"));
    auto closeOld = bindClose.call(rt, oldHandle).asObject(rt).getFunction(rt);
    publish(1); rustra::getChannelDispatcher()->requestResetAfterSwap();
    auto newHandle = createFn.call(rt, newCallback);
    auto closeNew = bindClose.call(rt, newHandle).asObject(rt).getFunction(rt);
    closeOld.call(rt);
    check(owners[1].drops == 0, "old JS close released new core channel");
    owners[1].json(owners[1].channelData, 1, "new"); invoker->drain(rt);
    check(newCalls == 1, "new channel stopped delivering after stale close");
    check(closeNew.call(rt).getBool(), "current bound close failed");
    check(!closeNew.call(rt).getBool(), "bound close must be idempotent");
  });
}
}
