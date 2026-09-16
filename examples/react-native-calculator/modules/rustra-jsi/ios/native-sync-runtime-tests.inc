// Separate runtimes may operate on separate threads. No test ABI state is used.
static void runtimeIsolationTests() {
  std::array<std::string, 2> errors;
  std::array<std::thread, 2> workers;
  for (size_t worker = 0; worker < workers.size(); ++worker) {
    workers[worker] = std::thread([worker, &errors] {
      try {
        for (int generation = 0; generation < 3; ++generation) {
          auto runtime = facebook::hermes::makeHermesRuntime();
          auto& rt = *runtime;
          const std::string marker = "runtime-" + std::to_string(worker);
          auto input = evaluate(rt, "({nodes:[{id:1,name:'node',tag:'folder',note:'" + marker + "',metadata:{owner:'x'},children:[]}]})");
          rustra::codec::Writer writer;
          if (!rustra::generated::encode_by_id(rt, 34, input, writer)) throw std::runtime_error("encode unavailable");
          rustra::codec::Reader reader(writer.data() + 2, writer.size() - 2);
          auto result = rustra::generated::decode_by_id(rt, 34, reader);
          auto node = result.asObject(rt).getPropertyAsObject(rt, "nodes").asArray(rt).getValueAtIndex(rt, 0).asObject(rt);
          if (node.getProperty(rt, "note").asString(rt).utf8(rt) != marker) throw std::runtime_error("cross-runtime property");
        }
      } catch (const std::exception& error) { errors[worker] = error.what(); }
    });
  }
  for (auto& worker : workers) worker.join();
  for (const auto& error : errors) {
    try { check(error.empty(), error); }
    catch (const std::exception& failure) { ++failures; std::cerr << "FAIL concurrent runtimes: " << failure.what() << '\n'; }
  }
  std::cout << "CHECK concurrent runtime recreation completed\n";
}

// A decorator's C++ address is not the identity/lifetime of its underlying VM.
static void runtimeDecoratorReuseTest() {
  // JSError may retain engine values: both engines must outlive the catch.
  auto first = facebook::hermes::makeHermesRuntime();
  auto second = facebook::hermes::makeHermesRuntime();
  try {
    evaluate(*second, "globalThis.padding={}; for(let i=0;i<200;i++) padding['foreign'+i]=i;");
    std::optional<CountingRuntime> wrapper;
    auto* previousAddress = static_cast<CountingRuntime*>(nullptr);
    for (auto* engine : {first.get(), second.get(), first.get()}) {
      auto input = evaluate(*engine, "({nodes:[{id:1,name:'node',tag:'folder',note:'snapshot',metadata:{owner:'x'},children:[]}]})");
      wrapper.emplace(*engine);
      if (previousAddress) check(previousAddress == &*wrapper, "decorator address was not reused");
      previousAddress = &*wrapper;
      rustra::codec::Writer writer;
      check(rustra::generated::encode_by_id(*wrapper, 34, input, writer), "decorated codec unavailable");
      rustra::codec::Reader reader(writer.data() + 2, writer.size() - 2);
      auto result = rustra::generated::decode_by_id(*wrapper, 34, reader);
      auto node = result.asObject(*engine).getPropertyAsObject(*engine, "nodes").asArray(*engine).getValueAtIndex(*engine, 0).asObject(*engine);
      check(node.getProperty(*engine, "note").asString(*engine).utf8(*engine) == "snapshot", "decorator reused foreign runtime IDs");
      wrapper.reset();
    }
    std::cout << "PASS decorator address reuse with two live Hermes runtimes\n";
  } catch (const std::exception& error) {
    ++failures; std::cerr << "FAIL decorator address reuse: " << error.what() << '\n';
  }
}
