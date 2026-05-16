require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'RustraCalculator'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['repository']['url'] if package['repository']
  s.license      = package['license']
  s.authors      = package['author']
  s.source       = { :git => '' }
  s.swift_version = '5.4'

  s.platforms    = { :ios => '15.1' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'

  s.vendored_libraries = 'rust/lib/librustra_calculator_example.a'
  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '-force_load $(PODS_TARGET_SRCROOT)/rust/lib/librustra_calculator_example.a',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/ios"',
  }

  s.dependency 'ExpoModulesCore'
end
