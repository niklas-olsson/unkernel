<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright 2026 the unkernel contributors -->

# Offline chat benchmark

Run the benchmark from a checkout with the web dependencies, matching
kernel, Debian image and GL renderer assets.

```sh
node test/wland/page-check.mjs --chat-bench
```

This uses the same prepared disk as `--chromium`. The runner creates it
if missing, which requires network access to Debian's package mirrors.
With the disk prepared, the workload runs offline. Use `--chrome PATH`
to select the headless host Chromium binary, `--port N` for a free
local port, and `--cpus N` to vary the guest CPU count. Default guest
configuration is four CPUs in worker mode with 2048 MiB. The runner
uses disposable browser profiles and SwiftShader for the host's GL
backend. Guest Wayland buffers can be GPU-backed even with a software
host GL backend. Run this mode on its own with the prepared disk.

The host tab and a real Debian Chromium window load the same 900×650
fixture. It displays 12 spaces, 48 channels and 320 messages. Each run clicks
the composer, types 24 `m` characters at nominal 350 ms intervals and
requests 180 downward 46-pixel wheel events at nominal 60/s over the feed.
The runner checks the resulting unsent draft, trusted input samples and
forward scroll movement. It applies no timing thresholds.

The `{"benchmark":"chat",...}` lines are JSON records. They report the
browser version, viewport, outcome, and durations for wheel dispatch
and wheel delivery. The following fields describe app and compositor timing.

- `readyMs` from the app's navigation time origin to its second initial
  animation callback.
- `keydownToInputMs` between trusted DOM keydown and input events in the app.
- `scrollEventGapMs` and `scrollRafGapMs` between successive scroll events
  and animation callbacks in the app during its wheel phase.
- Guest `wayland.commitGapMs` for host-observed Wayland surface
  commits between the first and last observed host DOM wheel events,
  with counts for all commits and GPU-backed commits.

A distribution contains the sample count, p50 and p95 when it has
samples. The startup marker excludes browser process startup. The
input metric excludes dispatch time before the app receives the key.
Callbacks and surface commits are distinct from captured pixels or
display presentation.
