Pod::Spec.new do |s|
  s.name         = 'RustraWasmSpike'
  s.version      = '0.0.0'
  s.summary      = 'wasm3 + rustra wasm32 spike module'
  s.author       = 'Rustra contributors'
  s.homepage     = 'https://github.com/loopy-lim/rustra'
  s.license      = 'MIT'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  s.static_framework = true

  # prepare_command stages everything CocoaPods needs INSIDE the pod root
  # (ios/wasm3/*.c, ios/rust/lib/*.a) from the spike tree above — required
  # because this podspec is consumed from bun's node_modules file:-dep copy
  # and CocoaPods rejects source_files outside the pod root.
  s.prepare_command = 'sh ios/build-rust-ios.sh'

  s.source_files        = 'ios/*.{h,mm}', 'ios/wasm3/*.c'
  s.public_header_files = 'ios/RustraWasmSpikeModule.h', 'ios/wasm3/wasm3.h'
  s.vendored_libraries  = 'ios/rust/lib/*.a'
  s.dependency 'React-Core'
  install_modules_dependencies(s)

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/ios/wasm3"',
    'OTHER_LDFLAGS' => '$(inherited) -force_load $(PODS_TARGET_SRCROOT)/ios/rust/lib/librustra_wasm_spike_backend.a',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
  }
end
