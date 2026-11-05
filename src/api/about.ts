export interface AboutInfo {
  name: string;
  description: string;
  version: string;
  releaseVersion?: string;
  copyrightYear: number;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  architecture: string;
}

interface PackageMetadata {
  name: string;
  desktopName?: string;
  description?: string;
  version: string;
  releaseVersion?: string;
}

interface RuntimeMetadata {
  versions: Partial<Record<'electron' | 'chrome' | 'node', string>>;
  platform: string;
  architecture: string;
}

/**
 * Values shown by the About renderer. They are assembled in the preload so the sandboxed page
 * never needs Node globals, and the package version is embedded by the same build that ships it.
 */
export function createAboutInfo(pkg: PackageMetadata, runtime: RuntimeMetadata, now = new Date()): AboutInfo {
  return {
    name: pkg.desktopName || pkg.name,
    description: pkg.description || '',
    version: pkg.version,
    ...(pkg.releaseVersion ? { releaseVersion: pkg.releaseVersion } : {}),
    copyrightYear: now.getFullYear(),
    electron: runtime.versions.electron || 'unknown',
    chrome: runtime.versions.chrome || 'unknown',
    node: runtime.versions.node || 'unknown',
    platform: runtime.platform,
    architecture: runtime.architecture,
  };
}
