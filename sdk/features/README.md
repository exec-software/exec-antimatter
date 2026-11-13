# Feature management SDK

The C ABI lets local applications declare and query boolean features managed by
Antimatter. Overrides persist across application and desktop restarts. Repeating a
declaration preserves the existing default, description and override. Applications
must be registered in **Feature Management** before SDK calls are accepted.

Enable the local API there and copy its socket endpoint. The endpoint lasts for
the current desktop process; update your application configuration after a restart.
The API accepts only local connections through a private Unix socket. It does not
listen on TCP or accept browser requests. Processes running as your OS user can
manage registered application flags while it is enabled.

Build outside the source directory:

```sh
cmake -S sdk/features -B build/features
cmake --build build/features
```

Include `antimatter_features.h` and link `libantimatter_features`. Functions return
the effective boolean as `0` or `1`, or `-1` on errors, unavailable endpoints and
unknown features. Callers choose an explicit application fallback; the SDK does
not turn connection failures into disabled features. Set override `-1` to restore
the declared default. List writes JSON into a caller-owned buffer without truncation.
Socket I/O has two-second per-operation deadlines; these calls belong off UI threads.

`antimatter_features.matrix` declares the same primitive C ABI using Matrix's
native `host` interop. Compile it with the consuming program for a native object
route, then link the C SDK and the NIL runtime hooks used by that program. The
interpreter does not provide these host functions. See the integration tests for
the compiler invocation and actual exported-symbol checks.

The native transport currently supports Linux and macOS. The Antimatter dashboard
itself does not require the native SDK. Windows transport is not claimed by ABI 1.
The SDK source is covered by Antimatter's MIT license.

## Release distribution

Desktop packages contain this SDK at `resources/sdk/features`. Linux releases also publish
`antimatter-feature-sdk-<version>-linux-x86_64.tar.gz` with the C source/header, Matrix host
bindings, CMake project, MIT license and `libantimatter_features.so`. The manifest records
the target, ABI version and checksum of every file. The library exports all four ABI functions
declared by the header and needs only the platform C runtime. Native macOS packaging includes
the corresponding `.dylib`. Windows packages include sources and bindings only; ABI 1's Unix
socket transport is not available there.

Link the supplied Linux SDK using `-I/path/to/sdk -L/path/to/sdk -lantimatter_features` and make
the library available to the dynamic loader (for example, install it with your application).
From an extracted SDK, rebuild with `cmake -S . -B /path/to/external/build/features` and
`cmake --build /path/to/external/build/features`. Antimatter's release packaging checks that
the included source matches the released checkout and verifies the packaged library inventory.
