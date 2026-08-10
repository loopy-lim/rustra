# rustra-bridge Lynx 네이티브 모듈 podspec.
# Lynx SDK(Lynx, LynxService) + Rust staticlib 를 링크한다.
Pod::Spec.new do |s|
  s.name             = 'RustraLynx'
  s.version          = '0.1.0'
  s.summary          = 'rustra-bridge Lynx Native Module (rkyv V2 fast-path)'
  s.homepage         = 'https://github.com/loopy-lim/rustra'
  s.license          = { :type => 'MIT' }
  s.author           = { 'loopy-lim' => '' }
  s.source           = { :path => '.' }

  s.ios.deployment_target = '14.0'
  s.source_files        = '*.{h,m}'
  s.public_header_files = '*.h'

  # Rust staticlib
  s.vendored_libraries  = 'rust/lib/librustra_calculator_example.a'
  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '-force_load $(PODS_TARGET_SRCROOT)/rust/lib/librustra_calculator_example.a'
  }

  # Lynx Engine + Service (앱 통합 시 Cocapods 로 설치되는 pod 이름)
  s.dependency 'Lynx'
  s.dependency 'LynxService'
end
