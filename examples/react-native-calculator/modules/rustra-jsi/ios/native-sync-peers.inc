// Test ABI peers, not replacement JSI/codec/binder implementations.
namespace native_test {
namespace jsi = facebook::jsi;
using Table = rustra::core::CoreTable;
struct Allocation { size_t size; int owner; bool owned; };
static std::unordered_map<uint8_t*, Allocation> live;
static int allocationErrors = 0;
struct Peer {
  std::string hash, schema;
  bool raw = true;
  int hashes = 0, schemas = 0, frames = 0, raws = 0, buffers = 0, frees = 0, ownedFrees = 0;
  int mode = 0;
  bool pending = false;
  std::vector<uint8_t> request, response;
  std::function<void()> duringFrame;
};
static Peer peers[12];
static Table tables[12];

static uint8_t* allocate(int owner, bool owned, const uint8_t* bytes, size_t size) {
  auto* p = static_cast<uint8_t*>(std::malloc(std::max<size_t>(1, size)));
  if (!p) throw std::bad_alloc();
  if (size) std::memcpy(p, bytes, size);
  live.emplace(p, Allocation{size, owner, owned});
  return p;
}
template<int I, bool Owned> static void release(uint8_t* p, size_t size) {
  auto found = live.find(p);
  if (found == live.end() || found->second.owner != I || found->second.size != size || found->second.owned != Owned) {
    ++allocationErrors;
    return;
  }
  if constexpr (Owned) ++peers[I].ownedFrees; else ++peers[I].frees;
  live.erase(found); std::free(p);
}
template<int I> static uint8_t* hash(size_t* size) {
  ++peers[I].hashes; *size = peers[I].hash.size();
  return allocate(I, false, reinterpret_cast<const uint8_t*>(peers[I].hash.data()), *size);
}
template<int I> static uint8_t* schema(size_t* size) {
  ++peers[I].schemas; *size = peers[I].schema.size();
  return allocate(I, false, reinterpret_cast<const uint8_t*>(peers[I].schema.data()), *size);
}
template<int I> static uint8_t hasRaw(uint16_t id) { return peers[I].raw && id == 23; }
template<int I> static uint32_t hasBuffer(uint16_t id) { return id == 25; }
static std::vector<uint8_t> errorFrame() {
  // ok=0, reserved seven bytes, body length=13, postcard strings "test", "failure".
  return {0,0,0,0,0,0,0,0,13,0,4,'t','e','s','t',7,'f','a','i','l','u','r','e'};
}
template<int I> static size_t frame(const uint8_t* request, size_t size, uint8_t* out, size_t cap, size_t* length) {
  auto& p = peers[I]; ++p.frames;
  if (p.pending) {
    if (p.request != std::vector<uint8_t>(request, request + size)) throw std::runtime_error("overflow changed request");
    p.pending = false;
  } else {
    p.request.assign(request, request + size);
    p.response.assign(8, 0); p.response[0] = 1;
    const auto id = size >= 2 ? request[0] | (request[1] << 8) : 0;
    if (id == 23) {
      if (size != 18) throw std::runtime_error("unexpected add request");
      double a, b; std::memcpy(&a, request + 2, 8); std::memcpy(&b, request + 10, 8);
      const double value = a + b + I * 1000;
      const auto* bytes = reinterpret_cast<const uint8_t*>(&value);
      p.response.insert(p.response.end(), bytes, bytes + 8);
    } else if (id == 16 || id == 24 || id == 25 || id == 26 || id == 34) {
      p.response.insert(p.response.end(), request + 2, request + size);
    } else throw std::runtime_error("unexpected fake command");
    if (p.mode == 1) p.response = errorFrame();
    if (p.mode == 2) p.response = {1};
    if (p.mode == 3) { *length = 0; return 0; }
    auto callback = std::move(p.duringFrame); p.duringFrame = {};
    if (callback) callback();
  }
  *length = p.response.size();
  if (cap < *length) { p.pending = true; return SIZE_MAX; }
  std::memcpy(out, p.response.data(), *length); return *length;
}
template<int I> static uint32_t raw(uint16_t id, const uint64_t* slots, size_t count,
  uint64_t* out, uint8_t* error, size_t cap, size_t* errorSize) {
  auto& p = peers[I]; ++p.raws;
  if (id != 23 || count != 2) throw std::runtime_error("unexpected raw request");
  if (p.mode == 4) return UINT32_MAX;
  if (p.mode == 1) {
    auto e = errorFrame(); *errorSize = e.size();
    if (cap >= e.size()) std::memcpy(error, e.data(), e.size());
    return 1;
  }
  double a, b; std::memcpy(&a, slots, 8); std::memcpy(&b, slots + 1, 8);
  double value = a + b + I * 1000; std::memcpy(out, &value, 8); return 0;
}
template<int I> static uint32_t buffer(uint16_t id, const uint8_t* bytes, size_t size, uint8_t** out, size_t* length) {
  auto& p = peers[I]; ++p.buffers;
  if (id != 25) throw std::runtime_error("unexpected buffer command");
  static const std::string error = "test: failure";
  *length = p.mode == 1 ? error.size() : size;
  *out = allocate(I, true, p.mode == 1 ? reinterpret_cast<const uint8_t*>(error.data()) : bytes, *length);
  return p.mode == 1 ? 1 : 0;
}
template<int I> static void initTable() {
  auto t = rustra::core::kStaticCoreTable;
  t.contract_hash = hash<I>; t.get_schema = schema<I>; t.free = release<I,false>;
  t.has_raw = hasRaw<I>; t.has_buffer = hasBuffer<I>; t.invoke_frame_into = frame<I>;
  t.invoke_raw = raw<I>; t.invoke_buffer = buffer<I>; t.free_owned_bytes = release<I,true>;
  tables[I] = t;
}
static void initializePeers() {
  const std::string commands = R"([{"name":"span","commandId":16,"execution":"sync"},{"name":"benchAdd","commandId":23,"execution":"sync"},{"name":"benchEchoString","commandId":24,"execution":"sync"},{"name":"benchEchoBytes","commandId":25,"execution":"sync"},{"name":"benchEchoPair","commandId":26,"execution":"sync"},{"name":"parityEcho","commandId":34,"execution":"sync"}])";
  for (auto& p : peers) {
    p.hash = rustra::generated::compiled_contract_hash();
    p.schema = "{\"registryFrozen\":true,\"schemaGeneration\":1,\"commands\":" + commands + "}";
  }
  peers[2].hash = "different";
  peers[3].schema = R"({"registryFrozen":true,"schemaGeneration":1,"commands":[{"name":"benchAdd","commandId":23,"execution":"async"}]})";
  peers[4].schema = R"({"registryFrozen":false,"schemaGeneration":1,"commands":[]})";
  peers[5].schema = R"({"registryFrozen":true,"schemaGeneration":1.5,"commands":[]})";
  peers[6].schema = R"({"registryFrozen":true,"schemaGeneration":1,"commands":[{"name":"benchAdd","commandId":24,"execution":"sync"}]})";
  peers[7].schema = "not JSON";
  peers[8].raw = false;
  peers[9].schema = R"({"registryFrozen":true,"schemaGeneration":1,"commands":[{"name":"benchAdd","commandId":23}]})";
  peers[10].schema = R"({"registryFrozen":true,"schemaGeneration":9007199254740992,"commands":[]})";
  peers[11].schema = R"({"registryFrozen":true,"schemaGeneration":-1,"commands":[]})";
  initTable<0>(); initTable<1>(); initTable<2>(); initTable<3>(); initTable<4>(); initTable<5>();
  initTable<6>(); initTable<7>(); initTable<8>(); initTable<9>(); initTable<10>(); initTable<11>();
}
static void publish(int id) {
  if (id < 0 || id >= 12) throw std::runtime_error("invalid peer");
  rustra::core::g_coreTable.store(&tables[id], std::memory_order_release);
}
}
