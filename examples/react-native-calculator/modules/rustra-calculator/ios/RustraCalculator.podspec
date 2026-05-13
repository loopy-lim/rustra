Pod::Spec.new do |s|
  s.name           = 'RustraCalculator'
  s.version        = '1.0.0'
  s.summary        = 'A sample project summary'
  s.description    = 'A sample project description'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.prepare_command = 'sh build-rust-ios.sh'
  s.vendored_libraries = 'rust/lib/librustra_calculator_example.a'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -force_load ${PODS_TARGET_SRCROOT}/rust/lib/librustra_calculator_example.a',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
