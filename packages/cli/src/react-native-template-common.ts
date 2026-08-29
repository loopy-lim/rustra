export function renderModuleIndex(): string {
  return `import { NativeModules } from 'react-native';
import { getRustraNative as getInstalledNative } from '@rustra/react-native';

type Installer = { install(): Promise<boolean | void> };

function nativeInstaller(): Installer {
  const current = NativeModules.RustraBridge as Installer | undefined;
  if (!current) {
    throw new Error(
      '[rustra:autolink] RustraBridge was not linked. Run ' +
        '\`bunx --bun react-native config\` to inspect bare RN autolinking, then ' +
        '\`cd ios && pod install\` or rebuild Android. Expo Go cannot load JSI; Expo apps need a development build.',
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
      type: 'module',
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
  legacyDefinition: string;
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
${options.legacyDefinition}    'OTHER_LDFLAGS' => "$(inherited) -force_load $(PODS_TARGET_SRCROOT)/#{rust_archive}",
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
end
`;
}
