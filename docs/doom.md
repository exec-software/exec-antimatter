# Doom easter egg

Enable **Settings → Appearance → Show Doom easter egg**, then open **Doom** from the tool bar. The panel can be docked or floated like other tools. It starts only when you click **Play**.

Freedoom: Phase 2 is included. **Choose IWAD** loads your own complete Doom game data; add-on PWADs are not supported. Local WADs stay on your computer and are limited to 64 MB. Each WAD has separate saved games, identified by its SHA-256 digest rather than its filename.

Use arrows to move, Ctrl to fire, Space to interact, and Shift to run. F2 or **Save** opens the save menu; choose a slot, enter a name, and press Enter. F3 or **Load** restores a saved slot. **Capture mouse** enables pointer lock; Escape releases it. **Pause / resume** pauses gameplay.

Save before closing the panel. Antimatter persists completed save slots immediately and restores them before the engine starts again. It does not invent an autosave of unsaved gameplay. The close/update handshake waits for outstanding slot writes, reports disk failures, and times out after three seconds instead of hanging the application.

The game runs in a sandboxed frame with an opaque origin, no Electron bridge, no parent-document access, and no network access. Only validated save-slot bytes cross its message boundary. Game commands cannot change chat permissions or start agent tools.

## Runtime and release packaging

The engine is an unmodified Chocolate Doom WebAssembly build from [gabrielbotandev/doom-wasm](https://github.com/gabrielbotandev/doom-wasm/tree/64de0924591dec59a7d49a7d10467e125b50ea99), pinned at `64de0924591dec59a7d49a7d10467e125b50ea99`. The upstream build script identifies Emscripten 4.0.14 and contains the build commands and source modifications. Freedoom 0.13.0 is included in the engine's data package. No proprietary id Software game data ships with Antimatter.

`scripts/doom-runtime.lock.json` records immutable URLs, sizes, and SHA-256 hashes for every runtime, source, and notice file. Stage the files outside the source checkout:

```sh
node scripts/sync-doom-runtime.mjs --output /path/to/build/doom
node scripts/sync-doom-runtime.mjs --output /path/to/build/doom --verify-only
```

Set `ANTIMATTER_DOOM_RUNTIME=/path/to/build/doom` for desktop development and packaging. The required `afterPack` hook copies the **entire verified directory** as `resources/doom`, including `runtime-manifest.json`, before signing and archive/AppImage creation. It rejects missing, changed, extra or symlinked files. Linux release assembly verifies the copied payload again and records its complete inventory in the release manifest. There are no game downloads on an end user's machine.

The shipped directory includes:

- Chocolate Doom loader, WebAssembly binary, and Freedoom data package.
- `corresponding-source.tar.gz`: the complete source tree at the pinned revision, including engine source and rebuild script, supplied alongside the GPL engine binary.
- Chocolate Doom's GPL-2.0 license text, upstream notices, Emscripten and SDL2 license texts.
- Freedoom's BSD-3-Clause license and contributor/music credits.

Keep these files together in every platform's distributable. Replacing an engine artifact requires a new pinned lock, corresponding source for that build, and the game/save/reload smoke test. The game's licenses are separate from Antimatter's license.

For automated verification, set external `ANTIMATTER_SMOKE_OUTPUT` and `ANTIMATTER_DOOM_RUNTIME` directories, then run `node scripts/smoke-doom.mjs`. It launches the actual WASM engine with isolated storage, starts a Freedoom level, saves to private disk, recreates the engine, loads the saved slot, and checks iframe isolation. No existing user profile is touched.
