# Ny and Matrix in Antimatter Code

**Code** is the editor workspace for NIL Framework projects. Ny (`.ny`) and
Matrix (`.matrix` and `.mat`) share the compiler, runtime, debugger, project
configuration, and NIL inspector. Existing folder editing and custom run
commands remain available for other languages. The internal `environment`
route and saved sidebar visibility preference are retained during upgrades.

## Chat folders

Code follows the active chat's saved working folder. **Open folder** binds another
folder to that chat; creating a project binds its new folder too. Switching chats
updates Code automatically when there is no unsaved work. Modified buffers or a
running task offer **Save & switch**, **Discard & switch**, or **Stop & switch**;
**Back to chat** leaves the existing Code workspace intact. Chats using the same
folder share the current open buffers. Missing folders show a repair action rather
than silently opening an unrelated default folder.

Opening a chat-bound Code workspace does not change the global tools folder or
reconnect another chat's tool servers.

## Create or open a project

Choose **Code → New project**, select **Ny**, **Matrix**, or **Ny + Matrix**,
enter a name, and choose a parent folder. Antimatter creates a new folder with
`nil.project.json`, a runnable entrypoint under `src`, an explicit smoke-test
project under `tests`, `.gitignore`, and a README. The mixed starter calls a Ny
module from Matrix. An existing folder is never overwritten.

**Open folder** opens an existing workspace. The nearest `nil.project.json`
inside that workspace supplies the entrypoint, include paths, output directory,
and analyzer policy. Opening a source in a nested project selects that project.
**Project settings** opens the actual manifest for editing. Invalid manifests
show an error and block project tasks instead of silently running a single file.

Use **SDK → Choose SDK** to select a complete NIL Framework SDK or repository.
Current SDKs provide `nilcompiler`, `nilinterpreter`, `nillsp`, `nildebugger`, and
`nilbuild`. The resolver also supports coherent legacy Ny SDKs for single-file
work. Project tasks require `nilbuild`. Discovery checks configured NIL/NY SDK
environment variables, the workspace, PATH, and sibling framework checkouts;
an explicit SDK selection takes precedence. Tools from different installations
or tool families are not combined. Manifest SDK paths configure imports, not
executable tool selection.

## Edit and navigate

Both languages have highlighting, indentation, folding, comments, completion,
and language-specific snippets. **Ctrl+Space** requests completion, hover shows
information, and **F12** navigates to a definition. The **Outline** shows the
current buffer's hierarchy and can be filtered or hidden to make more room.

With a current NIL compiler, live analysis includes open unsaved source buffers
and the project's import roots and analyzer policy. Diagnostics appear inline
and in **Problems**; select a problem to open its source line. Editing a buffer
retires its old diagnostics. Requests are serialized, bounded, and cancelled
when superseded. Compiler byte ranges are converted to editor UTF-16 positions,
and returned source snapshots are checked before navigation or edits.

Compiler completion and definitions use the SDK's partial semantic index;
unsupported or ambiguous bindings return no result. The language server still
supplies tolerant hover and document outline. Offline snippets remain usable
when tools are unavailable. Antimatter does not advertise workspace rename,
formatting, references, or signature-help controls in this pass.

## Check, build, and run

**Check**, **Build**, **Run**, and **Debug** save modified open files first. A
save conflict blocks the task. For projects, the commands operate on the
manifest entrypoint, even while an imported module is selected.

- **Check** invokes `nilbuild check` without executing the program.
- **Build** invokes `nilbuild build` for **NIL VM** or **Native**.
- **Run** invokes `nilbuild run`, which checks and builds fresh output before
  executing it. A failed check cannot run an earlier successful artifact.
- **Stop** cancels a pending task or stops the owned program/debugger.

The manifest controls output paths (normally `build/<name>.nil` for the VM).
Native builds require an LLVM-enabled SDK and a compatible host C++ linker.
Native debugging is not offered; select **NIL VM** for source debugging.
Without a manifest, the managed source runner compiles the selected Ny or
Matrix file into `.antimatter/build/`; custom commands are also available.

**Output** has separate **Program** and **Build** channels. The terminal remains
mounted while other panels are open, so switching to Problems or Variables
does not discard streamed output. Failed checks expose line-linked diagnostics.

The generated smoke test is its own manifest, since the current driver has no
test-discovery command. Open `tests/smoke.ny` to select it, or run:

```sh
nilbuild run --project tests/nil.project.json
```

## Debug

Click a source gutter to set a breakpoint, then choose **Debug**. Project debug
first runs the project check and compiles a temporary source-mapped NIL artifact
with the same imports and SDK. `nildebugger --dap` pauses at entry; Continue,
Pause, Step Over, Step Into, Step Out, and Stop operate on the real VM session.
Matrix and Ny source locations and breakpoints are preserved across mixed calls.

**Variables** shows lexical locals and read-only name/member inspection.
**Call stack** selects the frame used for locals and evaluation. Verified source
breakpoints are distinguished from unresolved positions. Runtime exceptions
retain their source location. Owned temporary artifacts are removed on exit,
failed launch, or cancellation.

Keyboard shortcuts while Code is open:

| Shortcut | Action |
| --- | --- |
| F5 | Debug, or continue when paused |
| Ctrl/Cmd+F5 | Run |
| Shift+F5 | Stop |
| F10 | Step over |
| F11 / Shift+F11 | Step into / step out |
| Ctrl/Cmd+Shift+B | Build |
| Ctrl/Cmd+S | Save current file |
| F12 | Go to definition |

The current adapter debugs source-mapped NIL, not native executable attachment.
Variable mutation, arbitrary expression execution, interactive debuggee stdin,
and stepping individual parallel workers are not exposed. Library frames
outside the open workspace remain visible but cannot be opened in its editor.

## Inspect compiled NIL

Open a `.nil` file or choose **Inspect NIL** after a VM build. The read-only
inspector displays metadata, functions, instructions and operands, constants,
annotations, types, and available source records. Mapped source links navigate
to Ny or Matrix inside the workspace. Project builds use the driver's standard
artifact settings; **Debug** creates a separate artifact with source maps.

The inspector reads text NIL and supported binary versions 1–5 without executing
the program. Unsupported records or versions produce an error. Opening an
artifact does not run it. **Reload** refreshes an artifact changed on disk.
Aperture remains a separate framework prototype; this workspace does not imply
that profiling or tracing integration is already available.

## Verification

Set `ANTIMATTER_NY_TEST_SDK` to a current complete SDK to run installed-toolchain
integration tests. Coverage includes starter creation, real checks/builds/runs,
failed-check rejection of stale artifacts, dirty-buffer compiler analysis,
Matrix and mixed-language source debugging, locals, stepping, cancellation,
and legacy Ny debugger regression cases. These tests use temporary projects
and do not modify the SDK. Without the variable, SDK-specific tests are skipped.

`scripts/smoke-ny-workflow.mjs` exercises the Code UI against a controlled host:
project creation, project tasks, diagnostics, output, debug panels, and themes.

`scripts/smoke-nil-runtime.mjs` runs a real generated Matrix project through
Electron and node-pty, verifies streamed output and exit, and checks that Stop
retires nilbuild and its compiler child. It requires the SDK environment
variable and a native node-pty build compatible with the host and Electron.
