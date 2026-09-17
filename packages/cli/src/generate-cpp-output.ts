import type { PackageSchema } from './schema.js';
import { sha256 } from './hash.js';
import { generatedFileHeader } from './generated-header.js';
import { analyzeCppCommands } from './generate-cpp-analysis.js';
import { appendCppRuntimeHelpers } from './generate-cpp-runtime-helpers.js';
import { appendCppMapEntries } from './generate-cpp-map-entries.js';
import { appendCppGeneratedFunctions } from './generate-cpp-functions.js';
import { appendCppDispatchCore } from './generate-cpp-dispatch-core.js';
import { appendCppBoundContext } from './generate-cpp-bound-context.js';
import { appendCppBufferDispatch } from './generate-cpp-dispatch-buffer.js';
export { generateFrameCodecsHpp } from './generate-cpp-hpp.js';

export function generateFrameCodecsCpp(schema: PackageSchema, schemaContent?: string): string {
  const sets = analyzeCppCommands(schema);
  const lines: string[] = [
    generatedFileHeader('rustra-generated-codecs.cpp', 'schema → cpp codec renderer').trimEnd(),
    `// C++ postcard codec for the RN JSI fast path (B1).`,
    `#include "rustra-generated-codecs.hpp"`,
    `#include <algorithm>`,
    `#include <array>`,
    `#include <cmath>`,
    `#include <cstring>`,
    `#include <jsi/jsi.h>`,
    `#include <initializer_list>`,
    `#include <limits>`,
    `#include <stdexcept>`,
    `#include <string>`,
    `#include <utility>`,
    `#include <vector>`,
    ``,
    `using namespace facebook::jsi;`,
    `namespace jsi = facebook::jsi;`,
    `namespace rc = rustra::codec;`,
    // Hash the original bytes, exactly as contract.ts does. Object serialization
    // cannot recover whitespace/order from a parsed or legacy schema argument.
    `namespace rustra::generated {`,
    `const char* compiled_contract_hash() { return ${schemaContent === undefined ? 'nullptr' : JSON.stringify(sha256(schemaContent))}; }`,
    `}`,
    ``,
  ];
  appendCppMapEntries(lines);
  appendCppRuntimeHelpers(lines);
  appendCppBoundContext(lines, sets);
  appendCppGeneratedFunctions(lines, sets);
  appendCppDispatchCore(lines, sets);
  appendCppBufferDispatch(lines, sets);
  return lines.join('\n') + '\n';
}
