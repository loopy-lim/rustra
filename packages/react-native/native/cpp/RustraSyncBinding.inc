// Included in RustraJSIBridge.cpp after the shared typed tail and buffer helpers.
// New public sync bindings must never validate one hot core and invoke another.
namespace {

struct SyncMetadataBytes {
  const CoreTable* core;
  uint8_t* data;
  size_t size;
  ~SyncMetadataBytes() { if (data) core->free(data, size); }
};

static uint32_t codecCapabilities(const CoreTable* core, uint16_t id) {
  uint32_t capabilities = 0;
  if (gen::has_static_codec_id(id)) capabilities |= 1;
  if (gen::has_pos_codec(id)) capabilities |= 2;
  if (gen::has_raw_codec(id) && core->has_raw(id)) capabilities |= 4;
  if (gen::has_buffer_codec(id) && core->has_buffer(id)) capabilities |= 8;
  return capabilities;
}

static uint32_t validateSyncCore(Runtime& rt, const CoreTable* core, uint16_t id,
                                const std::string& name, const std::string& expectedHash) {
  // Older generated headers must still compile/link the existing Promise APIs.
  // Their missing identity disables only the additive synchronous binding.
  const char* compiledHash = nullptr;
#if defined(RUSTRA_GENERATED_CODEC_CONTRACT_IDENTITY)
  compiledHash = gen::compiled_contract_hash();
#endif
  SyncMetadataBytes hash{core, nullptr, 0};
  hash.data = core->contract_hash(&hash.size);
  if (!hash.data || !syncContractsMatch(compiledHash, expectedHash,
      std::string_view(reinterpret_cast<const char*>(hash.data), hash.size))) {
    throw JSError(rt, "sync.unavailable: compiled codec, native core and JS contracts must match");
  }
  SyncMetadataBytes schema{core, nullptr, 0};
  schema.data = core->get_schema(&schema.size);
  if (!schema.data) throw JSError(rt, "sync.unavailable: native schema unavailable");
  auto root = Value::createFromJsonUtf8(rt, schema.data, schema.size).asObject(rt);
  auto frozen = root.getProperty(rt, "registryFrozen");
  auto generation = root.getProperty(rt, "schemaGeneration");
  if (!frozen.isBool() || !frozen.getBool() || !generation.isNumber() ||
      generation.getNumber() < 0 || generation.getNumber() > 9007199254740991.0 ||
      !std::isfinite(generation.getNumber()) || std::trunc(generation.getNumber()) != generation.getNumber()) {
    throw JSError(rt, "sync.unavailable: immutable native registry metadata required");
  }
  auto commands = root.getPropertyAsObject(rt, "commands").asArray(rt);
  bool found = false;
  for (size_t index = 0; index < commands.size(rt); ++index) {
    auto entry = commands.getValueAtIndex(rt, index).asObject(rt);
    auto commandName = entry.getProperty(rt, "name");
    if (!commandName.isString() || commandName.asString(rt).utf8(rt) != name) continue;
    auto commandId = entry.getProperty(rt, "commandId");
    auto execution = entry.getProperty(rt, "execution");
    found = commandId.isNumber() && commandId.getNumber() == id && execution.isString() &&
            execution.asString(rt).utf8(rt) == "sync";
    break;
  }
  if (!found || !gen::has_static_codec_id(id)) {
    throw JSError(rt, "sync.unavailable: native command is not a generated synchronous command");
  }
  return codecCapabilities(core, id);
}

static Value invokeRawOnCore(Runtime& rt, const CoreTable* core, uint16_t id,
                           const Value* values, size_t count) {
  if (count > 8) throw JSError(rt, "sync.unavailable: too many scalar fields");
  uint64_t slots[8] = {}, output = 0;
  gen::encode_raw_slots(rt, id, values, count, slots);
  uint8_t error[256]; size_t errorLength = 0;
  auto status = core->invoke_raw(id, slots, count, &output, error, sizeof(error), &errorLength);
  if (status == UINT32_MAX) return Value(std::numeric_limits<double>::quiet_NaN());
  if (status != 0) {
    if (errorLength >= 10 && errorLength <= sizeof(error)) throw JSError(rt, parseFrameErrorBody(error, errorLength));
    throw JSError(rt, "RustraJSI: invokeTypedRaw failed");
  }
  return gen::decode_raw_result(rt, id, output);
}

static Value invokeBufferOnCore(Runtime& rt, const CoreTable* core, uint16_t id, const Value& value) {
  auto [data, size] = extractByteBuffer(rt, value);
  uint8_t* output = nullptr; size_t outputSize = 0;
  auto status = core->invoke_buffer(id, data, size, &output, &outputSize);
  if (status == UINT32_MAX || !output) throw JSError(rt, "RustraJSI: direct buffer ABI failed");
  if (status != 0) {
    std::string error(reinterpret_cast<const char*>(output), outputSize);
    core->free_owned_bytes(output, outputSize);
    throw JSError(rt, error.empty() ? "buffer invoke failed" : error);
  }
  auto buffer = createOwnedArrayBuffer(rt, output, outputSize, core);
  return gen::decode_buffer_result_by_id(rt, id, std::move(buffer));
}

static Value invokeBoundSync(Runtime& rt, const CoreTable* core, uint32_t capabilities,
                             uint16_t id, uint16_t route, const Value* args, size_t count) {
  if (count == 0) throw JSError(rt, "sync.unavailable: bound command requires its input");
  // route 0 = whole object, 1..3 = fixed field count, 4 = single byte field.
  const size_t fields = count - 1;
  if ((route == 0 && fields != 0) || (route >= 1 && route <= 3 && fields != route) ||
      (route == 4 && fields != 1)) throw JSError(rt, "sync.unavailable: invalid bound argument count");
  if (route == 4 && (capabilities & 8) && args[1].isObject() && !args[1].asObject(rt).isArray(rt)) {
    return invokeBufferOnCore(rt, core, id, args[1]);
  }
  if (route >= 1 && route <= 3 && (capabilities & 4)) {
    Value raw = invokeRawOnCore(rt, core, id, args + 1, fields);
    // Only this unavailable marker means no handler ran. Never retry an error.
    if (!(raw.isNumber() && std::isnan(raw.getNumber()))) return raw;
  }
  rc::Writer writer;
  if (route != 0 && (capabilities & 2)) gen::encode_pos_by_id(rt, id, args + 1, fields, writer);
  else if (!gen::encode_by_id(rt, id, args[0], writer)) throw JSError(rt, "sync.unavailable: native codec missing");
  return typedInvokeTail(rt, writer.data(), writer.size(), "", [&rt, id](rc::Reader& reader) {
    return gen::decode_by_id(rt, id, reader);
  }, nullptr, core);
}

static Value createNativeSyncBinding(Runtime& rt, uint16_t id, std::string command,
                                     std::string expectedHash, uint16_t route) {
  if (route > 4) throw JSError(rt, "sync.unavailable: unsupported binding route");
  auto cache = std::make_shared<ValidatedSyncCore<CoreTable, uint32_t>>();
  auto validate = [&rt, id, &command, &expectedHash](const CoreTable* core) {
    return validateSyncCore(rt, core, id, command, expectedHash);
  };
  cache->select(core::currentCoreTable(), validate); // Binding fails before exposing a function.
  auto name = PropNameID::forAscii(rt, "rustraBoundSync");
  return Function::createFromHostFunction(rt, name, route == 4 ? 2 : route + 1,
    [cache, id, route, command = std::move(command), expectedHash = std::move(expectedHash)]
    (Runtime& runtime, const Value&, const Value* args, size_t count) -> Value {
      // Atomic capture is the invocation boundary. Hot publish after this load
      // affects only subsequent calls. Table/dylib lifetime is process-long.
      const auto snapshot = cache->select(core::currentCoreTable(), [&](const CoreTable* core) {
        return validateSyncCore(runtime, core, id, command, expectedHash);
      });
      return invokeBoundSync(runtime, snapshot.core, snapshot.metadata, id, route, args, count);
    });
}

} // namespace
