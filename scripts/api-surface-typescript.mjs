// Emit declarations into memory from current workspace sources. Never read built dist.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const slash = (path) => path.replaceAll('\\', '/');
const ordered = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b, 'en')));
function targets(value, conditions = []) {
  if (typeof value === 'string') return [{ conditions, target: value }];
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => targets(v, [...conditions, String(i)]));
  if (typeof value !== 'object') throw new Error('Unsupported package export value');
  return Object.entries(value).flatMap(([key, v]) => targets(v, [...conditions, key]));
}
function sourceTarget(pkg, target, config) {
  if (!target.startsWith('./') || target.includes('*') || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(target))
    throw new Error(`Unsupported package export target: ${pkg}: ${target}`);
  const destination = resolve(pkg, target);
  if (relative(pkg, destination).startsWith('..'))
    throw new Error(`Export escapes package: ${target}`);
  const outDir = config.outDir ?? join(pkg, 'dist');
  const rootDir = config.rootDir ?? join(pkg, 'src');
  const rel = relative(outDir, destination);
  const source = rel.startsWith('..') ? destination : resolve(rootDir, rel);
  const base = source.replace(/(?:\.d)?\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/, '');
  const candidates = /\.[cm][jt]s$/.test(source)
    ? source.endsWith('mjs') || source.endsWith('mts')
      ? [base + '.mts', base + '.d.mts']
      : [base + '.cts', base + '.d.cts']
    : [base + '.ts', base + '.tsx', base + '.d.ts'];
  const found = candidates.find(existsSync);
  if (!found || relative(pkg, found).startsWith('..') || slash(found).includes('/dist/'))
    throw new Error(`No current TypeScript source for export ${pkg}: ${target}`);
  return resolve(found);
}
function references(sf) {
  const refs = [];
  function walk(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      refs.push(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      refs.push(node.argument.literal.text);
    if (
      ts.isExternalModuleReference(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression)
    )
      refs.push(node.expression.text);
    ts.forEachChild(node, walk);
  }
  walk(sf);
  refs.push(...sf.referencedFiles.map((r) => r.fileName));
  return refs;
}
export function collectTypeScript(root) {
  root = resolve(root);
  const packages = new Map();
  const aliases = new Map();
  const roots = new Set();
  const exportsMap = new Map();
  const assets = new Map();
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const pkg = join(root, 'packages', dir);
    const manifestPath = join(pkg, 'package.json');
    if (!existsSync(manifestPath)) {
      if (existsSync(join(pkg, 'src/index.ts')))
        throw new Error(`Missing package.json for TypeScript package ${pkg}`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private) continue;
    const configPath = join(pkg, 'tsconfig.json');
    let config = {};
    if (existsSync(configPath)) {
      const raw = ts.readConfigFile(configPath, ts.sys.readFile);
      if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
      config = ts.parseJsonConfigFileContent(raw.config, ts.sys, pkg).options;
    }
    let exports = manifest.exports ?? { '.': manifest.types ?? manifest.main ?? './dist/index.js' };
    if (
      typeof exports === 'string' ||
      exports === null ||
      Array.isArray(exports) ||
      !Object.keys(exports).some((k) => k.startsWith('.'))
    )
      exports = { '.': exports };
    packages.set(manifest.name, pkg);
    for (const [subpath, value] of Object.entries(exports)) {
      if (subpath.includes('*'))
        throw new Error(`Unsupported wildcard package export: ${manifest.name}${subpath}`);
      const key = `packages/${dir}${subpath === '.' ? '' : subpath.slice(1)}`;
      // Preserve condition order: Node resolves the first matching condition.
      exportsMap.set(key, JSON.stringify({ name: manifest.name, targets: value }));
      const entrySources = [];
      for (const { target } of targets(value)) {
        if (target.endsWith('.json')) {
          if (
            !target.startsWith('./') ||
            target.includes('*') ||
            relative(pkg, resolve(pkg, target)).startsWith('..')
          )
            throw new Error(`Unsupported asset export: ${target}`);
          if (target !== './package.json')
            assets.set(
              `${key}:${target}`,
              JSON.stringify(JSON.parse(readFileSync(resolve(pkg, target), 'utf8'))),
            );
          continue;
        }
        const source = sourceTarget(pkg, target, config);
        roots.add(source);
        entrySources.push(source);
      }
      const alias = `${manifest.name}${subpath === '.' ? '' : subpath.slice(1)}`;
      if (entrySources.length) aliases.set(alias, entrySources[0]);
    }
  }
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    removeComments: true,
    jsx: ts.JsxEmit.ReactJSX,
    rootDir: root,
    outDir: join(root, '.api-surface-memory'),
  };
  const host = ts.createCompilerHost(options);
  function resolveImport(name, containingFile) {
    if (aliases.has(name)) {
      const resolvedFileName = aliases.get(name);
      const extension = /\.d\.[cm]?ts$/.test(resolvedFileName)
        ? resolvedFileName.endsWith('.d.mts')
          ? ts.Extension.Dmts
          : resolvedFileName.endsWith('.d.cts')
            ? ts.Extension.Dcts
            : ts.Extension.Dts
        : resolvedFileName.endsWith('.tsx')
          ? ts.Extension.Tsx
          : resolvedFileName.endsWith('.mts')
            ? ts.Extension.Mts
            : resolvedFileName.endsWith('.cts')
              ? ts.Extension.Cts
              : ts.Extension.Ts;
      return { resolvedFileName, extension, isExternalLibraryImport: false };
    }
    if ([...packages.keys()].some((pkg) => name === pkg || name.startsWith(`${pkg}/`)))
      throw new Error(`Unmapped workspace package import ${name} in ${containingFile}`);
    const result = ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
    if (
      result &&
      slash(result.resolvedFileName).startsWith(slash(join(root, 'packages')) + '/') &&
      slash(result.resolvedFileName).includes('/dist/')
    )
      throw new Error(`Built workspace declaration is forbidden: ${result.resolvedFileName}`);
    return result;
  }
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => resolveImport(name, containingFile));
  const emitted = new Map();
  host.writeFile = (_name, text, _bom, _error, sources) => {
    for (const source of sources ?? []) emitted.set(resolve(source.fileName), text);
  };
  const program = ts.createProgram([...roots], options, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getDeclarationDiagnostics(),
  ];
  // Check our source declarations too; skipLibCheck would hide missing public
  // types in .d.ts/.d.mts/.d.cts. Third-party declaration diagnostics belong to
  // their dependency, but diagnostics in workspace sources always fail closed.
  const errors = diagnostics.filter(
    (d) =>
      d.category === ts.DiagnosticCategory.Error &&
      (!d.file || !slash(d.file.fileName).includes('/node_modules/')),
  );
  if (errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  const result = program.emit();
  if (result.emitSkipped || result.diagnostics.length)
    throw new Error(
      `TypeScript declaration emit failed: ${result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`,
    );
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const declarations = new Map();
  const visit = (file) => {
    file = resolve(file);
    const key = slash(relative(root, file));
    if (declarations.has(key)) return;
    const text =
      emitted.get(file) ?? (/\.d\.[cm]?ts$/.test(file) ? readFileSync(file, 'utf8') : undefined);
    if (text === undefined) throw new Error(`Missing in-memory declaration for ${file}`);
    const sf = ts.createSourceFile(
      file.replace(/\.[cm]?tsx?$/, '.d.ts'),
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    declarations.set(key, printer.printFile(sf).trim());
    for (const ref of references(sf)) {
      const dependency = resolveImport(ref, file);
      // Ambient modules such as node:fs have no resolved file; semantic diagnostics
      // above have already verified their declarations. Relative refs must resolve.
      if (!dependency) {
        if (ref.startsWith('.'))
          throw new Error(`Cannot resolve declaration import ${ref} from ${file}`);
        continue;
      }
      if (
        emitted.has(resolve(dependency.resolvedFileName)) ||
        (slash(dependency.resolvedFileName).startsWith(slash(join(root, 'packages')) + '/') &&
          !slash(dependency.resolvedFileName).includes('/node_modules/'))
      )
        visit(dependency.resolvedFileName);
    }
  };
  for (const file of roots) visit(file);
  return {
    packageExports: ordered(exportsMap),
    packageAssets: ordered(assets),
    tsDeclarations: ordered(declarations),
  };
}
