import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RULES = {
  rustraLibSize: 'rustra-lib-size',
  typesIndexSize: 'types-index-size',
  cliIndexSize: 'cli-index-size',
  sharedRustNaming: 'shared-rust-naming',
  sharedJsonEngine: 'shared-json-engine',
  watcherBoundary: 'watcher-boundary',
  rnRuntimeDuplication: 'rn-runtime-duplication',
  sourceModuleSize: 'source-module-size',
};

const FACADE_LIMITS = {
  'crates/rustra/src/lib.rs': 200,
  'packages/types/src/index.ts': 200,
  'packages/cli/src/index.ts': 200,
};

const RECOMMENDED_MODULE_LINES = 200;
const HARD_MODULE_LINES = 400;

function readIfPresent(root, path) {
  const absolutePath = join(root, path);
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, 'utf8');
}

function readDirectorySources(root, directory) {
  const absoluteDirectory = join(root, directory);
  if (!existsSync(absoluteDirectory)) return '';
  return readdirSync(absoluteDirectory)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => readIfPresent(root, `${directory}/${entry}`) ?? '')
    .join('\n');
}

function lineCount(source) {
  return source.split(/\r?\n/).length;
}

function rustSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (entry.endsWith('.rs')) files.push(path);
    }
  };

  visit(join(root, 'crates'));
  return files;
}

function productionSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (
        (entry.endsWith('.ts') || entry.endsWith('.rs')) &&
        !entry.endsWith('.test.ts') &&
        !entry.endsWith('_tests.rs') &&
        !path.includes('/tests/')
      ) files.push(path);
    }
  };

  visit(join(root, 'packages'));
  visit(join(root, 'crates'));
  return files;
}

function error(rule, path, message) {
  return { rule, path, message };
}

export function checkArchitectureBoundaries({ root }) {
  const errors = [];
  const warnings = [];

  for (const [path, limit] of Object.entries(FACADE_LIMITS)) {
    const source = readIfPresent(root, path);
    if (!source) continue;
    const lines = lineCount(source);
    if (lines > limit) {
      const rule = path === 'crates/rustra/src/lib.rs'
        ? RULES.rustraLibSize
        : path === 'packages/types/src/index.ts'
          ? RULES.typesIndexSize
          : RULES.cliIndexSize;
      errors.push(error(rule, path, `${lines} lines exceeds the ${limit}-line facade budget`));
    }
  }

  const moduleSizes = productionSourceFiles(root)
    .map((path) => ({ path: relative(root, path), lines: lineCount(readFileSync(path, 'utf8')) }))
    .sort((left, right) => right.lines - left.lines);
  for (const module of moduleSizes) {
    if (module.lines <= RECOMMENDED_MODULE_LINES || Object.hasOwn(FACADE_LIMITS, module.path)) continue;
    const violation = error(
      RULES.sourceModuleSize,
      module.path,
      `${module.lines} lines exceeds the recommended ${RECOMMENDED_MODULE_LINES}-line module budget`,
    );
    if (module.lines > HARD_MODULE_LINES) {
      violation.message += ` and the hard ${HARD_MODULE_LINES}-line ceiling; split by responsibility`;
      errors.push(violation);
    } else {
      violation.message += `; up to ${HARD_MODULE_LINES} lines is allowed when the responsibility remains cohesive`;
      warnings.push(violation);
    }
  }

  const namingImplementations = rustSourceFiles(root).filter((path) => {
    const source = readFileSync(path, 'utf8');
    return /(?:pub\s*\([^)]*\)\s*)?fn\s+snake_to_lower_camel\s*\(/.test(source);
  });
  if (
    namingImplementations.length !== 1 ||
    !namingImplementations[0]?.endsWith('crates/rustra-naming/src/lib.rs')
  ) {
    errors.push(
      error(
        RULES.sharedRustNaming,
        'crates/rustra-naming/src/lib.rs',
        `expected one shared naming implementation, found ${namingImplementations.length}`,
      ),
    );
  }

  for (const adapter of ['node', 'bun', 'tauri']) {
    const path = `packages/${adapter}/src/index.ts`;
    const source = readDirectorySources(root, `packages/${adapter}/src`);
    if (!source) continue;
    if (!/\bcreateJsonEngine\b/.test(source) || !/@rustra\/types/.test(source)) {
      errors.push(
        error(
          RULES.sharedJsonEngine,
          path,
          'adapter must use createJsonEngine from @rustra/types',
        ),
      );
    }
  }

  const cliIndex = readIfPresent(root, 'packages/cli/src/index.ts');
  if (cliIndex && /\b(?:setTimeout|setInterval|watch)\s*\(/.test(cliIndex)) {
    errors.push(
      error(
        RULES.watcherBoundary,
        'packages/cli/src/index.ts',
        'watcher timers and filesystem subscriptions belong in packages/cli/src/watch.ts',
      ),
    );
  }

  const rnIndex = readIfPresent(root, 'packages/react-native/src/index.ts');
  const rnUtf8 = readIfPresent(root, 'packages/react-native/src/utf8.ts');
  if (
    rnUtf8 ||
    (rnIndex && /\braceAbortShallow\b|\b(?:function|const|let)\s+(?:encodeUtf8|decodeUtf8|exactArrayBuffer)\b/.test(rnIndex))
  ) {
    errors.push(
      error(
        RULES.rnRuntimeDuplication,
        'packages/react-native/src',
        'React Native must consume the shared types runtime helpers',
      ),
    );
  }

  return { errors, warnings, moduleSizes };
}

if (process.argv[1] && process.argv[1].endsWith('architecture-boundaries.mjs')) {
  const report = checkArchitectureBoundaries({ root: process.cwd() });
  if (report.errors.length > 0) {
    for (const violation of report.errors) {
      console.error(`[${violation.rule}] ${violation.path}: ${violation.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Architecture boundaries: OK');
    for (const warning of report.warnings) {
      console.warn(`[${warning.rule}] ${warning.path}: ${warning.message}`);
    }
  }
}
