Pod::Spec.new do |s|
  s.name           = 'RustraJSI'
  s.version        = '1.0.0'
  s.summary        = 'Rustra JSI Bridge for React Native'
  s.author         = ''
  s.homepage       = 'https://github.com/loopy-lim/rustra'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.prepare_command = 'sh build-rust-ios.sh'
  s.vendored_libraries = 'rust/lib/librustra_calculator_example.a'

  s.source_files = "**/*.{h,mm,hpp,cpp}"
  s.exclude_files = "**/test-*.{cpp,hpp}"

  s.dependency 'React-jsi'
  s.dependency 'React-Core'

  install_modules_dependencies(s)

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -force_load ${PODS_TARGET_SRCROOT}/rust/lib/librustra_calculator_example.a',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
end
