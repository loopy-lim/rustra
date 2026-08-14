# rustra runner 템플릿 Lynx 네이티브 모듈 podspec.
# Lynx SDK(Lynx, LynxService) + Rust staticlib(rustra-template-backend) 를 링크한다.
# 스파이크 examples/lynx-calculator/modules/rustra-lynx/ios/RustraLynx.podspec 에서 정제 추출.
Pod::Spec.new do |s|
  s.name             = 'RustraLynx'
  s.version          = '0.1.0'
  s.summary          = 'rustra runner template Lynx Native Module (rkyv V2 fast-path)'
  s.homepage         = 'https://github.com/loopy-lim/rustra'
  s.license          = { :type => 'MIT' }
  s.author           = { 'loopy-lim' => '' }
  s.source           = { :path => '.' }

  s.ios.deployment_target = '14.0'
  s.source_files        = '*.{h,m}'
  s.public_header_files = '*.h'

  # Rust staticlib — build-rust-ios.sh 가 rust/lib/ 에 배치.
  s.vendored_libraries  = 'rust/lib/librustra_template_backend.a'
  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '-force_load $(PODS_TARGET_SRCROOT)/rust/lib/librustra_template_backend.a'
  }

  # Lynx Engine + Service (CocoaPods source pod).
  s.dependency 'Lynx'
  s.dependency 'LynxService'
end
