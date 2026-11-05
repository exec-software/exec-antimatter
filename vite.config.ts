import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import electron, { startup as pluginElectronStartup } from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import electronExecutable from 'electron';
import { DevElectronProcess } from './src/main/devElectronProcess';

// If this config is hot-reloaded after the plugin's default launcher ran, remove
// its broad process-exit tree killer before adopting that existing child below.
process.removeListener('exit', pluginElectronStartup.exit);

// Keep one owner across Vite config reloads. vite-plugin-electron's default
// restart walks children of the Vite process and can kill sibling esbuild
// services; our owner launches Electron in an isolated process group instead.
const devGlobal = globalThis as typeof globalThis & {
  __antimatterElectronDevProcess?: DevElectronProcess;
};
const devElectron =
  devGlobal.__antimatterElectronDevProcess ??
  (devGlobal.__antimatterElectronDevProcess = new DevElectronProcess({
    // Electron's ambient application typings obscure the package's Node-side
    // default export, which is the executable path used by dev tooling.
    executable: electronExecutable as unknown as string,
  }));

function restartElectron(reason: string): void {
  void devElectron.restart(reason).catch((error: unknown) => {
    console.error('[electron-dev] Could not restart Electron:', error);
  });
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: '../../src/main/index.ts',
        onstart() {
          restartElectron('main process rebuilt');
        },
        vite: {
          build: {
            outDir: '../../dist-electron/main',
            rollupOptions: {
              // node-pty is a native module: bundling it would swallow the .node binary it
              // loads at runtime, so it stays a require() against node_modules.
              //
              // bufferutil and utf-8-validate are ws's optional native speedups. ws requires
              // them inside a try/catch and falls back to its JavaScript path, so leaving them
              // unresolved is correct — bundling refuses outright if they are not listed here.
              external: ['electron', 'node-pty', 'bufferutil', 'utf-8-validate'],
            },
          },
        },
      },
      // Sandboxed preloads cannot require local chunks. Build each entry independently so
      // shared helpers are inlined without weakening the avatar's sandbox.
      ...['index', 'avatar'].map((name) => ({
        entry: `../../src/preload/${name}.ts`,
        onstart() {
          // Preload is part of the Electron IPC ABI. Reloading only the renderer can expose a
          // new bridge against an old main-process handler table, so replace the whole Electron
          // process. DevElectronProcess coalesces this with simultaneous main/MCP rebuilds.
          restartElectron('preload process rebuilt');
        },
        vite: {
          build: {
            outDir: '../../dist-electron/preload',
            emptyOutDir: false,
            rollupOptions: {
              external: ['electron'],
              output: { inlineDynamicImports: true },
            },
          },
        },
      })),
      {
        // Antimatter's own MCP server. It runs as its own process, spawned by the main process,
        // so it is bundled separately and never imports electron.
        entry: '../../mcp/server.ts',
        onstart() {
          restartElectron('MCP process rebuilt');
        },
        vite: {
          build: {
            outDir: '../../dist-electron/mcp',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    {
      name: 'antimatter-electron-dev-cleanup',
      apply: 'serve',
      configureServer(server) {
        server.httpServer?.once('close', () => {
          void devElectron.stop().catch((error: unknown) => {
            console.error('[electron-dev] Could not stop Electron:', error);
          });
        });
      },
    },
    renderer(),
  ],
  root: 'renderer/src',
  build: {
    // Keep renderer output beside main/preload/MCP. A path relative to renderer/src used to
    // build successfully into renderer/src/dist-electron, which electron-builder never packed.
    outDir: '../../dist-electron/renderer',
    emptyOutDir: true,
    // Recovery and About are dependency-light entries. They still have to be emitted beside the
    // main renderer: electron-builder packages dist-electron, not the renderer source directory.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'renderer/src/index.html'),
        recovery: resolve(__dirname, 'renderer/src/recovery.html'),
        about: resolve(__dirname, 'renderer/src/about.html'),
        avatar: resolve(__dirname, 'renderer/src/avatar.html'),
        detached: resolve(__dirname, 'renderer/src/detached.html'),
      },
    },
  },
});
