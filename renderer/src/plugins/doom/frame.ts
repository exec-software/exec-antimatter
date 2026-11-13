/** This function is serialized into an opaque-origin iframe. Keep it self-contained. */
function gameFrameRuntime() {
  // SDL's native resize path targets #canvas; this id must match even with Module.canvas set.
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const status = document.getElementById('status')!;
  let started = false;
  let runtime: any;
  let channel = '';
  const report = (kind: string, detail: unknown = {}) => parent.postMessage({ channel, kind, detail }, '*');
  const key = (name: string, code: number) => {
    for (const type of ['keydown', 'keyup']) canvas.dispatchEvent(new KeyboardEvent(type, { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true }));
  };
  const saves = () => {
    if (!runtime) return [];
    return runtime.FS.readdir('/savegames').filter((name: string) => /^doomsav[0-7]\.dsg$/.test(name)).map((name: string) => ({ name, bytes: new Uint8Array(runtime.FS.readFile(`/savegames/${name}`)) }));
  };
  window.addEventListener('message', async (event) => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const { kind, detail } = event.data;
    if (kind === 'boot' && !started) {
      started = true; channel = event.data.channel;
      try {
        const engineUrl = URL.createObjectURL(new Blob([detail.engine.javascript], { type: 'text/javascript' }));
        const { default: createModule } = await import(/* @vite-ignore */ engineUrl);
        const config = 'fullscreen 0\nwindow_width 640\nwindow_height 400\ngrabmouse 0\nuse_mouse 1\n';
        runtime = await createModule({ canvas, keyboardListeningElement: canvas, noInitialRun: true,
          wasmBinary: detail.engine.wasm, locateFile: (name: string) => name,
          getPreloadedPackage: () => detail.engine.data.buffer.slice(detail.engine.data.byteOffset, detail.engine.data.byteOffset + detail.engine.data.byteLength),
          print: (text: string) => { document.documentElement.dataset.engineLog = ((document.documentElement.dataset.engineLog ?? '') + '\n' + text).slice(-2000); }, printErr: (text: string) => { if (/error|failed|fatal/i.test(text)) report('log', String(text).slice(0, 500)); },
          onAbort: (reason: unknown) => report('error', String(reason).slice(0, 500)),
          preRun: [(module: any) => {
            for (const directory of ['/config', '/savegames', '/uploads']) module.FS.mkdirTree(directory);
            module.FS.writeFile('/config/default.cfg', config);
            module.FS.writeFile('/config/extra.cfg', 'smooth_pixel_scaling 0\nforce_software_renderer 1\n');
            if (detail.wad) module.FS.writeFile('/uploads/game.wad', detail.wad.bytes);
            for (const save of detail.saves) module.FS.writeFile(`/savegames/${save.name}`, save.bytes);
          }],
        });
        URL.revokeObjectURL(engineUrl);
        const close = runtime.FS.close.bind(runtime.FS);
        runtime.FS.close = (stream: any) => {
          const path = stream.path;
          close(stream);
          if (/^\/savegames\/doomsav[0-7]\.dsg$/.test(path) && (stream.flags & 3) !== 0) report('save', saves());
        };
        const rename = runtime.FS.rename.bind(runtime.FS);
        runtime.FS.rename = (from: string, to: string) => {
          rename(from, to);
          if (/^\/savegames\/doomsav[0-7]\.dsg$/.test(to)) report('save', saves());
        };
        const args = ['-window', '-iwad', detail.wad ? '/uploads/game.wad' : '/iwads/freedoom2.wad', '-savedir', '/savegames', '-config', '/config/default.cfg', '-extraconfig', '/config/extra.cfg'];
        try { runtime.callMain(args); } catch (error) { if (!/unwind|SimulateInfiniteLoop/.test(String(error))) throw error; }
        status.textContent = ''; canvas.focus(); report('running');
      } catch (error) { status.textContent = 'Could not start the game.'; report('error', String(error).slice(0, 500)); }
    } else if (event.data.channel === channel && runtime) {
      if (kind === 'flush') report('snapshot', { id: detail.id, files: saves() });
      if (kind === 'pause') { key('Pause', 19); canvas.focus(); }
      if (kind === 'save-menu') { key('F2', 113); canvas.focus(); }
      if (kind === 'load-menu') { key('F3', 114); canvas.focus(); }
    }
  });
  canvas.addEventListener('click', () => canvas.focus());
  document.getElementById('pointer')!.addEventListener('click', () => { void canvas.requestPointerLock(); canvas.focus(); });
  document.getElementById('fullscreen')!.addEventListener('click', () => { void document.documentElement.requestFullscreen(); canvas.focus(); });
  parent.postMessage({ kind: 'ready' }, '*');
}

export const DOOM_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; media-src blob:; img-src data: blob:"><style>html,body{margin:0;background:#080808;color:#ccc;font:12px sans-serif;height:100%;overflow:hidden}body{display:flex;flex-direction:column}canvas{width:100%!important;height:calc(100% - 28px)!important;min-height:0;object-fit:contain;image-rendering:pixelated;outline:none}footer{height:28px;display:flex;align-items:center;gap:8px;padding:0 8px}button{color:inherit;background:#222;border:1px solid #444;border-radius:3px;font-size:11px}</style></head><body><canvas id="canvas" width="640" height="400" tabindex="0" aria-label="Doom game"></canvas><footer><span id="status">Starting…</span><button id="pointer">Capture mouse</button><button id="fullscreen">Full screen</button></footer><script>(${gameFrameRuntime.toString()})();</script></body></html>`;
