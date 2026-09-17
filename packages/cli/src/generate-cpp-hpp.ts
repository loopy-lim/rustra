import type { PackageSchema } from './schema.js';
import { generatedFileHeader } from './generated-header.js';

export function generateFrameCodecsHpp(_schema: PackageSchema): string {
  return (
    generatedFileHeader('rustra-generated-codecs.hpp', 'schema → cpp codec renderer').trimEnd() +
    '\n' +
    `// C++ postcard codec for the RN JSI fast path (B1).\n` +
    `// C++는 postcard subset과 Set을 제외한 complex subset을 직접 인코딩/디코딩한다.\n` +
    `// Set을 포함한 complex 명령은 JS codec이 invokeFrame로 전달하고, 동적 명령은\n` +
    `// JS Tier 3 fallback을 사용한다.\n` +
    `#pragma once\n\n` +
    `#include <cstddef>\n#include <cstdint>\n#include <memory>\n#include <jsi/jsi.h>\n#include <string>\n#include "rustra-codec.hpp"\n\n` +
    `// Optional adapter capability: old generated consumers omit this marker.\n` +
    `#define RUSTRA_GENERATED_CODEC_CONTRACT_IDENTITY 1\n` +
    `#define RUSTRA_GENERATED_BOUND_CODEC_CONTEXT 1\n\n` +
    `namespace rustra::generated {\n\n` +
    `const char* compiled_contract_hash();\n\n` +
    `// Internal bound codec handles belong to this runtime. Retain only in managed\n` +
    `// HostFunction captures or synchronous locals; never global/async owners or another runtime.\n` +
    `struct BoundCodecContext;\n` +
    `std::shared_ptr<const BoundCodecContext> make_bound_codec_context(facebook::jsi::Runtime& rt, uint16_t commandId);\n` +
    `bool encode_bound(facebook::jsi::Runtime& rt, const BoundCodecContext& context, const facebook::jsi::Value& args, rustra::codec::Writer& w);\n` +
    `facebook::jsi::Value decode_bound(facebook::jsi::Runtime& rt, const BoundCodecContext& context, rustra::codec::Reader& r);\n` +
    `facebook::jsi::Value decode_raw_bound(facebook::jsi::Runtime& rt, const BoundCodecContext& context, uint64_t slot);\n` +
    `facebook::jsi::Value decode_buffer_bound(facebook::jsi::Runtime& rt, const BoundCodecContext& context, facebook::jsi::Value buffer);\n\n` +
    `facebook::jsi::Value make_array_buffer(facebook::jsi::Runtime& rt, const uint8_t* data, size_t size);\n\n` +
    `bool encode_by_name(facebook::jsi::Runtime& rt, const std::string& name, const facebook::jsi::Value& args, rustra::codec::Writer& w);\n` +
    `facebook::jsi::Value decode_by_name(facebook::jsi::Runtime& rt, const std::string& name, rustra::codec::Reader& r);\n\n` +
    `bool encode_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id, const facebook::jsi::Value& args, rustra::codec::Writer& w);\n` +
    `facebook::jsi::Value decode_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id, rustra::codec::Reader& r);\n\n` +
    `bool has_static_codec(const std::string& name);\n` +
    `bool has_static_codec_id(uint16_t cmd_id);\n` +
    `bool has_pos_codec(uint16_t cmd_id);\n` +
    `bool has_buffer_codec(uint16_t cmd_id);\n\n` +
    `facebook::jsi::Value decode_buffer_result_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id, facebook::jsi::Value buffer);\n` +
    `void encode_buffer_by_id(uint16_t cmd_id, const uint8_t* data, size_t size, rustra::codec::Writer& w);\n\n` +
    `void encode_pos_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id, const facebook::jsi::Value* argv, size_t argc, rustra::codec::Writer& w);\n\n` +
    `bool has_raw_codec(uint16_t cmd_id);\n` +
    `void encode_raw_slots(facebook::jsi::Runtime& rt, uint16_t cmd_id, const facebook::jsi::Value* argv, size_t argc, uint64_t* slots);\n` +
    `facebook::jsi::Value decode_raw_result(facebook::jsi::Runtime& rt, uint16_t cmd_id, uint64_t slot);\n\n` +
    `} // namespace rustra::generated\n`
  );
}
