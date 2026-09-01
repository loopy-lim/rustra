import type { PackageSchema } from './schema.js';
import { generatedFileHeader } from './generated-header.js';
import { analyzeCppCommands } from './generate-cpp-analysis.js';
import { appendCppRuntimeHelpers } from './generate-cpp-runtime-helpers.js';
import { appendCppGeneratedFunctions } from './generate-cpp-functions.js';
import { appendCppDispatchCore } from './generate-cpp-dispatch-core.js';
import { appendCppBufferDispatch } from './generate-cpp-dispatch-buffer.js';
export { generateRkyvCodecsHpp } from './generate-cpp-hpp.js';

export function generateRkyvCodecsCpp(schema: PackageSchema): string {
  const sets = analyzeCppCommands(schema);
  const lines: string[] = [
    generatedFileHeader('rustra-generated-codecs.cpp', 'schema → cpp codec renderer').trimEnd(),
    `// C++ postcard codec for the RN JSI fast path (B1).`,
    `#include "rustra-generated-codecs.hpp"`,
    `#include <cmath>`,
    `#include <cstring>`,
    `#include <jsi/jsi.h>`,
    `#include <limits>`,
    `#include <memory>`,
    `#include <stdexcept>`,
    `#include <string>`,
    `#include <unordered_map>`,
    `#include <utility>`,
    ``,
    `using namespace facebook::jsi;`,
    `namespace jsi = facebook::jsi;`,
    `namespace rc = rustra::codec;`,
    ``,
  ];
  appendCppRuntimeHelpers(lines);
  appendCppGeneratedFunctions(lines, sets);
  appendCppDispatchCore(lines, sets);
  appendCppBufferDispatch(lines, sets);
  return lines.join('\n') + '\n';
}
