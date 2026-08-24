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

  s.dependency 'ExpoModulesCore'
  # RustraBridge owns and force-loads the single Rust static archive. Depending on
  # that pod keeps the Swift FFI comparison on the exact same Rust build while
  # avoiding duplicate symbols from linking the archive twice.
  s.dependency 'RustraBridge'
end
