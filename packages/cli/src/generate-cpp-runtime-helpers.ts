export function appendCppRuntimeHelpers(lines: string[]): void {
  lines.push(`namespace rustra { namespace generated {`);
  lines.push(`#ifdef RUSTRA_TEST_JSI_SHIM`);
  lines.push(`  using RuntimePropNameCache = std::unordered_map<std::string, jsi::PropNameID>;`);
  lines.push(`  std::shared_ptr<RuntimePropNameCache> runtimePropNameCache(jsi::Runtime&) {`);
  lines.push(`    static auto cache = std::make_shared<RuntimePropNameCache>();`);
  lines.push(`    return cache;`);
  lines.push(`  }`);
  lines.push(`#else`);
  lines.push(`  class RuntimePropNameCache final : public jsi::NativeState {`);
  lines.push(`  public:`);
  lines.push(`    std::unordered_map<std::string, jsi::PropNameID> values;`);
  lines.push(`  };`);
  lines.push(`  std::shared_ptr<RuntimePropNameCache> runtimePropNameCache(jsi::Runtime& rt) {`);
  lines.push(
    `    static std::unordered_map<jsi::Runtime*, std::weak_ptr<RuntimePropNameCache>> caches;`,
  );
  lines.push(`    auto found = caches.find(&rt);`);
  lines.push(`    if (found != caches.end()) {`);
  lines.push(`      if (auto cache = found->second.lock()) return cache;`);
  lines.push(`    }`);
  lines.push(`    auto cache = std::make_shared<RuntimePropNameCache>();`);
  lines.push(`    jsi::Object holder(rt);`);
  lines.push(`    holder.setNativeState(rt, cache);`);
  lines.push(`    rt.global().setProperty(rt, "__rustraPropNameCache", std::move(holder));`);
  lines.push(`    caches[&rt] = cache;`);
  lines.push(`    return cache;`);
  lines.push(`  }`);
  lines.push(`#endif`);
  lines.push(`  const jsi::PropNameID& cachedProp(jsi::Runtime& rt, const char* name) {`);
  lines.push(`    auto cache = runtimePropNameCache(rt);`);
  lines.push(`#ifdef RUSTRA_TEST_JSI_SHIM`);
  lines.push(`    auto& values = *cache;`);
  lines.push(`#else`);
  lines.push(`    auto& values = cache->values;`);
  lines.push(`#endif`);
  lines.push(`    auto it = values.find(name);`);
  lines.push(`    if (it == values.end()) {`);
  lines.push(`      it = values.emplace(name, jsi::PropNameID::forAscii(rt, name)).first;`);
  lines.push(`    }`);
  lines.push(`    return it->second;`);
  lines.push(`  }`);
  lines.push(`}}`, ``);
  lines.push(
    `[[maybe_unused]] static double rustra_f64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (!value.isNumber()) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a number");`,
  );
  lines.push(`  double number = value.asNumber();`);
  lines.push(
    `  if (!std::isfinite(number)) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be finite");`,
  );
  lines.push(`  return number;`, `}`);
  lines.push(
    `[[maybe_unused]] static int64_t rustra_i64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (value.isBigInt()) return value.asBigInt(rt).asInt64(rt);`,
    `  double number = rustra_f64(rt, value, field);`,
    `  constexpr double maxSafe = 9007199254740991.0;`,
    `  if (std::trunc(number) != number || number < -maxSafe || number > maxSafe)`,
  );
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a safe integer or bigint");`,
    `  return static_cast<int64_t>(number);`,
    `}`,
  );
  lines.push(
    `[[maybe_unused]] static uint64_t rustra_u64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (value.isBigInt()) return value.asBigInt(rt).asUint64(rt);`,
    `  double number = rustra_f64(rt, value, field);`,
    `  constexpr double maxSafe = 9007199254740991.0;`,
    `  if (std::trunc(number) != number || number < 0.0 || number > maxSafe)`,
  );
  lines.push(
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a non-negative safe integer or bigint");`,
    `  return static_cast<uint64_t>(number);`,
    `}`,
  );
  lines.push(
    `[[maybe_unused]] static uint8_t rustra_u8(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (!value.isNumber()) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a number");`,
    `  double number = value.asNumber();`,
    `  if (!(number >= 0.0 && number <= 255.0))`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be an integer in 0..255");`,
    `  uint8_t byte = static_cast<uint8_t>(number);`,
    `  if (static_cast<double>(byte) != number)`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be an integer in 0..255");`,
    `  return byte;`,
    `}`,
  );
  lines.push(`struct RustraByteSpan { const uint8_t* data; size_t size; };`);
  lines.push(
    `[[maybe_unused]] static RustraByteSpan rustra_bytes(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
  );
  lines.push(
    `  if (!value.isObject())`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a one-byte TypedArray, ArrayBuffer, or number[]");`,
    `  auto object = value.asObject(rt);`,
    `  if (object.isArrayBuffer(rt)) {`,
    `    auto buffer = object.getArrayBuffer(rt);`,
    `    auto size = buffer.length(rt);`,
    `    auto* data = buffer.data(rt);`,
    `    if (size > 0 && data == nullptr)`,
    `      throw jsi::JSError(rt, std::string("rustra: '") + field + "' has detached ArrayBuffer storage");`,
    `    return {data, size};`,
    `  }`,
  );
  lines.push(
    `  auto bytesPerElement = object.getProperty(rt, "BYTES_PER_ELEMENT");`,
    `  auto bufferValue = object.getProperty(rt, "buffer");`,
    `  auto offsetValue = object.getProperty(rt, "byteOffset");`,
    `  auto lengthValue = object.getProperty(rt, "byteLength");`,
  );
  lines.push(
    `  if (!bytesPerElement.isNumber() || bytesPerElement.asNumber() != 1.0 || !bufferValue.isObject() || !bufferValue.asObject(rt).isArrayBuffer(rt) || !offsetValue.isNumber() || !lengthValue.isNumber())`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a one-byte TypedArray or ArrayBuffer");`,
  );
  lines.push(
    `  auto buffer = bufferValue.asObject(rt).getArrayBuffer(rt);`,
    `  auto bufferSize = buffer.length(rt);`,
    `  double offsetNumber = offsetValue.asNumber();`,
    `  double lengthNumber = lengthValue.asNumber();`,
  );
  lines.push(
    `  if (!std::isfinite(offsetNumber) || !std::isfinite(lengthNumber) || std::trunc(offsetNumber) != offsetNumber || std::trunc(lengthNumber) != lengthNumber || offsetNumber < 0.0 || lengthNumber < 0.0 || offsetNumber > static_cast<double>(bufferSize) || lengthNumber > static_cast<double>(bufferSize) - offsetNumber)`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' view is outside its ArrayBuffer");`,
  );
  lines.push(
    `  auto offset = static_cast<size_t>(offsetNumber);`,
    `  auto size = static_cast<size_t>(lengthNumber);`,
    `  auto* data = buffer.data(rt);`,
    `  if (bufferSize > 0 && data == nullptr)`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' has detached TypedArray storage");`,
    `  return {size == 0 ? data : data + offset, size};`,
    `}`,
  );
  lines.push(
    `[[maybe_unused]] static float rustra_f32(jsi::Runtime& rt, const jsi::Value& value, const char* field) {`,
    `  double number = rustra_f64(rt, value, field);`,
    `  if (number < -std::numeric_limits<float>::max() || number > std::numeric_limits<float>::max())`,
    `    throw jsi::JSError(rt, std::string("rustra: '") + field + "' is outside the f32 range");`,
    `  return static_cast<float>(number);`,
    `}`,
    ``,
  );
}
