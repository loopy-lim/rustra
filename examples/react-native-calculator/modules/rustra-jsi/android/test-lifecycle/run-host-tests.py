#!/usr/bin/env python3
"""Compile actual generated queue logic against host RN/JNI test boundaries.

Uses kotlinc, or the example's already cached Gradle Kotlin 2.0.21 compiler.
No Android SDK, emulator, device or downloads are required.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

fixture = Path(__file__).resolve().parent
source_path = Path(os.environ.get(
    'RUSTRA_ANDROID_MODULE_SOURCE',
    fixture.parent / 'src/main/java/dev/rustra/bridge/RustraBridgeModule.kt',
))
source = source_path.read_text()
substitutions = {
    'System.loadLibrary("rustra_bridge")': 'Unit',
    'private external fun nativeInstall(pointer: Long, holder: CallInvokerHolder?): Boolean':
        'private fun nativeInstall(pointer: Long, holder: CallInvokerHolder?): Boolean = NativeProbe.install(reactApplicationContext, pointer, holder)',
    'private external fun nativeConfigureHotCore(path: String?)':
        'private fun nativeConfigureHotCore(path: String?) = NativeProbe.configure(path)',
    'private external fun nativeInvalidate()':
        'private fun nativeInvalidate() = NativeProbe.invalidate(reactApplicationContext)',
}
for before, after in substitutions.items():
    if source.count(before) != 1:
        raise RuntimeError(f'JNI boundary changed: {before}')
    source = source.replace(before, after)

with tempfile.TemporaryDirectory(prefix='rustra-android-lifecycle-') as temporary:
    output = Path(temporary)
    module = output / 'RustraBridgeModule.kt'
    module.write_text(source)
    sources = [str(module), *map(str, sorted(fixture.glob('*.kt')))]
    classes = output / 'classes'
    compiler = shutil.which('kotlinc')
    if compiler:
        jar = output / 'tests.jar'
        subprocess.run([compiler, *sources, '-include-runtime', '-d', str(jar)], check=True)
        subprocess.run(['java', '-jar', str(jar)], check=True)
    else:
        cache = Path(os.environ.get('GRADLE_USER_HOME', Path.home() / '.gradle')) / 'caches/modules-2/files-2.1'
        def artifact(group, name, version):
            jars = sorted((cache / group / name / version).glob('**/*.jar'))
            if not jars:
                raise RuntimeError(f'Missing cached {name}:{version}; install kotlinc or build the Android example first')
            return str(jars[0])
        kotlin = lambda name: artifact('org.jetbrains.kotlin', name, '2.0.21')
        stdlib = kotlin('kotlin-stdlib')
        annotations = artifact('org.jetbrains', 'annotations', '13.0')
        classpath = os.pathsep.join([
            kotlin('kotlin-compiler-embeddable'), stdlib, kotlin('kotlin-reflect'),
            kotlin('kotlin-script-runtime'), annotations,
            artifact('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'),
            artifact('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.1'),
        ])
        subprocess.run([
            'java', '-cp', classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
            '-no-stdlib', '-no-reflect', '-classpath', os.pathsep.join([stdlib, annotations]),
            '-d', str(classes), *sources,
        ], check=True)
        subprocess.run(['java', '-cp', os.pathsep.join([str(classes), stdlib]), 'dev.rustra.bridge.LifecycleTestKt'], check=True)
