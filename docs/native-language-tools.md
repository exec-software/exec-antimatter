# Native language tools

The editor supports Rust through `rust-analyzer` and C/C++ through `clangd`. Install these tools on the desktop host and put them on its `PATH`. A rustup shim without an installed rust-analyzer component is not a working server. Cargo/rustc and the C++ compiler/CMake are separate build tools; the project toolbar shows their availability.

Completion opens while typing or with Ctrl+Space. Hover shows symbol documentation. F12 navigates to a definition inside the current workspace. Error underlines and the Problems pane use current unsaved buffers. Editing or switching files discards stale analysis responses. Completion edits that add imports are applied in one undo step. Server-initiated workspace writes are refused.

Use **Restart language tools** in the editor status bar after installing a server or changing project configuration. If a server cannot start or times out, its error appears in the status bar; local keyword suggestions remain available. A pending analysis is not shown as a successful clean build.

Language processes start lazily for the chosen workspace. Cargo build scripts, procedural macros, check-on-save and clangd background indexing are disabled. CMake projects use `compile_commands.json` from Antimatter's external debug/release build directory after configuration. Standalone C++ uses C++20; C uses C17. Build/Test actions remain explicit, and their compiler diagnostics are separate from editor analysis.

Language-server output uses UTF-16 positions, bounded buffers and workspace paths. Definition navigation does not open files outside the selected workspace. Closing or restarting services closes the transport and bounds subprocess termination.

For a real clangd integration check, run `node scripts/smoke-native-language.mjs --help`. It tests member completion, hover, definitions, changing unsaved diagnostics and restarting the service against an explicitly selected clangd executable. It creates a small fixture outside the checkout and does not compile or index a project.
