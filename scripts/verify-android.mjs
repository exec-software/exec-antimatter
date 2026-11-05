#!/usr/bin/env node

/**
 * Exercise every Android variant we rely on without owning release signing material.
 *
 * Android Studio may provide android/local.properties. Headless builds should set ANDROID_HOME or
 * ANDROID_SDK_ROOT and make a JDK 17+ available through JAVA_HOME or PATH.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const windows = process.platform === 'win32';
const wrapper = path.join(ANDROID, windows ? 'gradlew.bat' : 'gradlew');

const fail = (message) => {
  console.error(`android:verify: ${message}`);
  process.exit(1);
};

if (!fs.statSync(wrapper, { throwIfNoEntry: false })?.isFile()) {
  fail(`missing Gradle wrapper: ${wrapper}`);
}

const localProperties = path.join(ANDROID, 'local.properties');
const configuredSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const defaultSdk = (() => {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Android', 'sdk');
  if (windows && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
  return path.join(home, 'Android', 'Sdk');
})();
const environment = { ...process.env };

const compilerName = windows ? 'javac.exe' : 'javac';
const configuredCompiler = environment.JAVA_HOME
  ? path.join(environment.JAVA_HOME, 'bin', compilerName)
  : null;
if (!configuredCompiler || !fs.statSync(configuredCompiler, { throwIfNoEntry: false })?.isFile()) {
  let discoveredHome = null;
  if (process.platform === 'darwin') {
    const discovered = spawnSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' });
    if (discovered.status === 0) discoveredHome = discovered.stdout.trim();
  } else {
    const compiler = (environment.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, compilerName))
      .find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (compiler) discoveredHome = path.dirname(path.dirname(fs.realpathSync(compiler)));
  }
  if (!discoveredHome || !fs.statSync(path.join(discoveredHome, 'bin', compilerName), { throwIfNoEntry: false })?.isFile()) {
    fail('set JAVA_HOME to a JDK 17+ installation (a JRE without javac is not sufficient)');
  }
  environment.JAVA_HOME = discoveredHome;
}
const compilerProbe = spawnSync(path.join(environment.JAVA_HOME, 'bin', compilerName), ['-version'], {
  encoding: 'utf8',
});
const compilerVersion = `${compilerProbe.stdout ?? ''}${compilerProbe.stderr ?? ''}`.match(/javac\s+(\d+)(?:\.(\d+))?/);
const compilerMajor = compilerVersion
  ? Number(compilerVersion[1] === '1' ? compilerVersion[2] : compilerVersion[1])
  : NaN;
if (compilerProbe.status !== 0 || !Number.isInteger(compilerMajor) || compilerMajor < 17) {
  fail(`JAVA_HOME must provide JDK 17 or newer (found ${compilerVersion?.[0] ?? 'an unreadable javac'})`);
}

if (!configuredSdk && !fs.existsSync(localProperties)) {
  if (fs.statSync(defaultSdk, { throwIfNoEntry: false })?.isDirectory()) {
    environment.ANDROID_HOME = defaultSdk;
  } else {
    fail('set ANDROID_HOME/ANDROID_SDK_ROOT or create android/local.properties with sdk.dir');
  }
}

const result = spawnSync(
  wrapper,
  [
    '--no-daemon',
    '--console=plain',
    ':app:testDebugUnitTest',
    ':app:lintDebug',
    ':app:lintRelease',
    ':app:assembleDebug',
    ':app:assembleRelease',
  ],
  {
    cwd: ANDROID,
    env: environment,
    stdio: 'inherit',
    shell: windows,
  }
);

if (result.error) fail(result.error.message);
if (result.signal) fail(`Gradle ended after signal ${result.signal}`);
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('Android unit tests, debug/release lint, and debug/release assembly passed.');
console.log('The release APK is intentionally unsigned; sign it in the protected distribution environment.');
