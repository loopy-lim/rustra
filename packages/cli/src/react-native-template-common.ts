export function renderModuleIndex(): string {
  return `import { NativeModules } from 'react-native';
import { getRustraNative as getInstalledNative } from '@rustra/react-native';

type Installer = { install(): Promise<boolean | void> };

function nativeInstaller(): Installer {
  const current = NativeModules.RustraBridge as Installer | undefined;
  if (!current) {
    throw new Error(
      '[rustra:autolink] RustraBridge was not linked. Run ' +
        '\`npx react-native config\` (or \`bunx --bun react-native config\`) to inspect bare RN ' +
        'autolinking, then \`cd ios && pod install\` or rebuild Android. Expo Go cannot load JSI; ' +
        'Expo apps need a development build.',
    );
  }
  return current;
}

export async function installRustraJSI(): Promise<void> {
  await nativeInstaller().install();
  getInstalledNative();
}

export function getRustraNative(): ReturnType<typeof getInstalledNative> {
  return getInstalledNative();
}
`;
}

export function renderPackageJson(adapterRange: string): string {
  return `${JSON.stringify(
    {
      name: '@rustra/generated-react-native',
      version: '0.0.0',
      private: true,
      // "type" 을 지정하지 않는다(=CommonJS) — RN CLI/gradle 오톬링킹이 이 패키지의
      // react-native.config.js 를 Node require() 로 읽는데, ESM 패키지로 표시하면
      // require 가 실패해 모듈이 링크에서 **조용히** 빠진다. bunx --bun 검증만으로는
      // 발견되지 않는다(Bun require 는 ESM 을 읽는다). 진입 TS 는 metro 가 번들하므로
      // 런타임 동작에는 영향이 없다.
      main: 'src/index.ts',
      'react-native': 'src/index.ts',
      peerDependencies: { '@rustra/react-native': adapterRange, 'react-native': '>=0.76' },
    },
    null,
    2,
  )}\n`;
}

export function renderReactNativeConfig(): string {
  return `module.exports = {
  dependency: {
    platforms: {
      ios: { podspecPath: './RustraBridge.podspec' },
      android: {
        sourceDir: './android',
        packageImportPath: 'import dev.rustra.bridge.RustraBridgePackage;',
        packageInstance: 'new RustraBridgePackage()',
      },
    },
  },
};
`;
}

export function renderPodspec(options: {
  adapterFromIos: string;
  generatedFromIos: string;
  rustLibrary: string;
}): string {
  return `Pod::Spec.new do |s|
  s.name = 'RustraBridge'
  s.version = '0.0.0'
  s.summary = 'Generated Rustra JSI bridge'
  s.author = 'Rustra contributors'
  s.homepage = 'https://github.com/loopy-lim/rustra'
  s.license = 'MIT'
  s.platforms = { :ios => '15.1' }
  s.source = { :path => '.' }
  s.static_framework = true

  adapter_root = File.expand_path('${options.adapterFromIos}', __dir__)
  generated_root = File.expand_path('${options.generatedFromIos}', __dir__)
  rust_archive = 'ios/rust/lib/lib${options.rustLibrary}.a'

  s.prepare_command = 'sh ios/build-rust-ios.sh'
  s.vendored_libraries = rust_archive
  s.source_files = 'ios/RustraBridge*.{mm,cpp}'
  s.dependency 'React-jsi'
  s.dependency 'React-Core'
  install_modules_dependencies(s)

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => "$(inherited) #{adapter_root}/cpp #{adapter_root}/ios #{generated_root}",
    'OTHER_LDFLAGS' => "$(inherited) -force_load $(PODS_TARGET_SRCROOT)/#{rust_archive}",
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
end
`;
}
