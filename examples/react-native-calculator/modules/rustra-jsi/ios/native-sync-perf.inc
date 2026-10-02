// Current caller timing with real Hermes/production JSI and a controlled C ABI
// producer. RUSTRA_NATIVE_SYNC_PERF disables peer counters/allocation ledgers.
// This is neither a real Rust-core benchmark nor an A/B speedup receipt.
static void nativeSyncPerf() {
  auto runtime = facebook::hermes::makeHermesRuntime(); auto& rt = *runtime;
  publish(0); useOwned(0, true); installTestAPI(rt);
  constexpr int warmup = 20000, iterations = 2000, samples = 101;
  for (const int bytes : {2, 1024}) {
    auto batch = evaluate(rt,
      "(()=>{const fn=bind(24,'benchEchoString',0); const input={value:'x'.repeat(" +
      std::to_string(bytes) + ")}; return n=>{let checksum=0;for(let i=0;i<n;i++)"
      "checksum+=fn(input).value.length;return checksum;};})()").asObject(rt).asFunction(rt);
    if (batch.call(rt, warmup).asNumber() != double(warmup * bytes)) {
      throw std::runtime_error("performance warmup returned incorrect output");
    }
    rt.instrumentation().collectGarbage("native-sync-perf-before-samples");
    std::vector<double> micros;
    for (int sample = 0; sample < samples; ++sample) {
      const auto start = std::chrono::steady_clock::now();
      auto result = batch.call(rt, iterations);
      const auto end = std::chrono::steady_clock::now();
      if (result.asNumber() != double(iterations * bytes)) {
        throw std::runtime_error("performance sample returned incorrect output");
      }
      micros.push_back(std::chrono::duration<double, std::micro>(end - start).count() / iterations);
    }
    auto ordered = micros; std::sort(ordered.begin(), ordered.end());
    std::cout << "NATIVE_SYNC_PERF {\"producer\":\"controlled-cabi-peer\","
      "\"runtime\":\"Hermes mac-catalyst\",\"command\":\"benchEchoString\","
      "\"route\":\"bound typed object\",\"ownedResponseEntry\":true,"
      "\"peerCountersAndLedger\":false,\"reusedInput\":true,"
      "\"payloadBytes\":" << bytes << ",\"warmupCalls\":" << warmup <<
      ",\"samples\":" << samples << ",\"callsPerSample\":" << iterations <<
      ",\"p50BatchMeanUs\":" << ordered[samples / 2] <<
      ",\"p95BatchMeanUs\":" << ordered[static_cast<size_t>((samples - 1) * .95)] <<
      ",\"batchMeanUs\":[";
    for (size_t i = 0; i < micros.size(); ++i) {
      if (i) std::cout << ',';
      std::cout << micros[i];
    }
    std::cout << "]}" << '\n';
  }
  rustra::invalidateRustraJSI();
}
