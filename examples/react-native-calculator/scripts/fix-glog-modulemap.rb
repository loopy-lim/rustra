# Scoped to the legacy glog pod used by RN 0.81. Keep modular imports enabled
# for other headers/pods; only namespace-internal includes must remain textual.
require 'json'

def rustra_fix_glog_modulemap(installer)
  glog = installer.pod_targets.find { |target| target.name == 'glog' }
  return unless glog && glog.root_spec.version.to_s == '0.3.5'

  root = installer.sandbox.root
  modulemap = root.join('Target Support Files', 'glog', 'glog.modulemap')
  contents = modulemap.read
  marker = '  // rustra: namespace-internal glog headers'
  return if contents.include?(marker)

  anchor = "module glog {\n"
  raise 'Unexpected glog module map; review the textual-header workaround.' unless contents.start_with?(anchor)

  headers = %w[log_severity.h vlog_is_on.h].map do |name|
    path = root.join('Headers', 'Public', 'glog', 'glog', name)
    raise "Missing glog header: #{path}" unless path.file?

    "  textual header #{JSON.generate(path.to_s)}"
  end
  modulemap.write(contents.sub(anchor, "#{anchor}#{marker}\n#{headers.join("\n")}\n"))
end
