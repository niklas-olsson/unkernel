# Guest GL through virgl on WebGL2

The design, what was measured, how to test, and what is open. It is in
unkernel: `createKernel({ gl: true })` in a browser (unkernel, below), the
page's Guest GL option, on by default on Debian (The page, below; web.md,
Guest GL), and with `gpu: true` too a real `/dev/dri` with 3D (The DRM
path, below). The renderer loads on the guest's first GL use (Loading on
first use, below). All
work happens on the `webgl` branch (this worktree). Do not change `main`,
and do not commit until asked.

## Goal

Give guest programs hardware GL in the browser, in place of llvmpipe under
kwemu. The guest runs stock Mesa with the `virgl` driver; the host runs
virglrenderer compiled to wasm against one WebGL2 context.

```
vtest: app -> Mesa virgl (virpipe) -> /tmp/.virgl_test -> kwbox vtest
       -> kwvsock, host CID 2, port 1019 -> VsockHost -> StreamHost
DRM:   app -> Mesa virtio_gpu (virgl) -> /dev/dri/renderD128 -> virtio_gpu
       -> kwvirtio -> VirtioGpu + VirglGpuBackend -> GpuRenderer
both:  -> virglrenderer (wasm) -> WebGL2 (one context, OffscreenCanvas,
       on the thread that owns the VM)
```

Decided, do not reopen without new facts:

- WebGL2, not WebGPU. Zink needs logic ops, transform feedback and
  non-solid fill, which WebGPU lacks; Venus needs host Vulkan 1.1 and
  guest-mappable device memory.
- Two paths on one renderer: vtest (a byte stream, no kernel driver; GL
  clients need `GALLIUM_DRIVER=virpipe`) and virtio-gpu (stock
  `/dev/dri`, nothing set in the guest; The DRM path).
- Browser only. Node has neither WebGL nor WebGPU.
- No window system work here. On the vtest path frames come back by
  readback (vtest transfer); on the DRM path a KMS client's scanout is
  presented from its texture. wland (a Wayland compositor for the page,
  `/workspace/github/pithings/wland`) is a later, separate integration and
  is not a prerequisite.

The guest sees GL 2.1 compatibility (GLSL 1.20) and GLES 3.0 (GLSL ES
3.00): no compute shaders, no texture buffers, no GL 3.3 core;
multisampling up to WebGL2's `MAX_SAMPLES` (4 on SwiftShader) through
renderbuffers, which cannot be sampled (patch 17).

## What exists (2026-11-21)

| Path | What |
| --- | --- |
| `gl/patches/virglrenderer/` | the one series on virglrenderer 1.3.0 (tag commit ca50e00), both builds; see Patches |
| `gl/wasm/` | the wasm module: `build.sh` (emscripten pinned in `pins.sh`; also the `native` build), `kw_virgl.c`/`.h` (C API, GL context hooks, vtest I/O, the virtio-gpu entry `kw_vgpu_*`), `kw_gl.js` (GL entry points made from WebGL2), `gl-missing.txt` (the stubs), `epoxy/` (libepoxy stand-in), `post.js` (`Module.virgl`, the page's renderer, `Module.virgl.gpu`); see WebGL2 |
| `gl/wasm/test/check.mjs` | loads the module in headless Chromium: init on WebGL2, caps, busy waits (one answered ahead of its fence, one parked), two inline clients, `Module.virgl.Renderer`, `Module.virgl.gpu` (capset, the capsets' versions and sizes against the SDK's `VIRGL_CAPSETS`, a packed transfer each way, present, a fence) |
| `gl/bridge/` | `vtest-bridge.c` (vtest socket to WebSocket or byte stream, fd termination) and the page that hosts a renderer: the wasm module or the relay to a native server; `README.md` has the wire dialect and the renderer interface |
| `test/gl/vtest-check.sh` | the check suite on this host; see Testing |
| `test/gl/bridge-check.sh` | the same suite with every byte through the page in headless Chromium; `--wasm` against the wasm renderer |
| `test/gl/kwgl-state.c` | the stale-state check run by `vtest-check.sh state` (surfaceless EGL clients taking turns) |
| `js/core/gl.ts`, `gl-stream.ts` | the SDK's host side: `createKernel({ gl })`, `GlHost` (`vm.gl`), `StreamHost`; see unkernel |
| `js/core/gl-gpu.ts` | virtio-gpu 3D: `VirglGpuBackend` (device side), `GpuRenderer` (`vm.gl.gpu`); see The DRM path |
| `test/gl/drm-page.js`, `drm.html`, `test/gpu/prime.c`, `test/gpu/window-image.c`, `test/gpu/int-attrib.c`, `test/gpu/msaa.c` | `unkernel-check.mjs --drm`: the DRM path in headless Chromium |
| `test/gl-gpu.test.ts` | `VirglGpuBackend` against a fake link: the snapshot blocker, contexts made again after a restore; `GpuRenderer` against fake renderers: a lost context, stale ids, new renderers (`pnpm test:gl-gpu`) |
| `test/gl/debian-disk.mjs` | makes the prepared data disk once (Mesa and the test programs installed in Debian's upper layer) |
| `test/gl/unkernel-check.mjs`, `unkernel.html`, `unkernel-page.js` | the whole path in unkernel in headless Chromium; see Testing |
| `test/gl/page-check.mjs` | the page's GL option in headless Chromium (the dev server, the default URL); see The page |
| `guest/base/rootfs/etc/profile.d/kw-gl.sh` | the guest's shells' `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1` when the command line has `kw.gl=1` and there is no DRM render node |
| `web/` (`config.ts`, `boot.ts` `showGl()`, `scripts/kernel.ts`, `vite.config.ts`) | the page's Guest GL option and how the page gets `virgl.*` (web.md, Guest GL) |
| `test/gl/build-guest-state.sh` | `kwgl-state.c` (or another GL test program, `window-image.c`) for the Debian guest (aarch64 glibc, linked against stand-ins for libEGL, libGLESv2 and libgbm) |
| `vendor/src/virglrenderer-wasm` (gitignored) | the source of both builds: branch `kw-wasm` = 1.3.0 + the series |
| `vendor/build/gl-wasm`, `vendor/build/gl-native` | `virgl.{mjs,wasm}`; `vtest/virgl_test_server` |
| `vendor/build/gl/` | `debian-gl.img` (the prepared disk), `kwgl-state-aarch64`, `vtest-bridge` (`build-guest.sh`) |

`vendor/` is not a record: commit on `kw-wasm` and re-export the series
(`gl/wasm/build.sh` has the command). `build.sh` never re-applies an
existing `kw-wasm`; it warns when its commit count and the series differ.

```sh
gl/wasm/build.sh             # toolchain, source, the module (a few min the first time)
gl/wasm/build.sh native      # virgl_test_server of the same source for vtest-check.sh
```

The native build needs (Fedora 44) `libepoxy-devel mesa-libgbm-devel
libdrm-devel mesa-libEGL-devel python3-pyyaml meson ninja`.

## Patches

In order, each with its reason in the commit message:

1. the single GL context mode (Single GL context);
2. the GL blitter's shaders as GLSL ES 3.00 on a GLES 3.0 host: they are
   GLSL ES 3.10, which such a host rejects, and then those blits (3D
   mipmaps, swizzled formats) do nothing;
3. vtest ignores SIGPIPE, so a dead client cannot kill a `--no-fork` server;
4. to 6. emscripten: meson without `-pthread`, Mesa's util, the DRM ioctl
   macros;
7. vtest for an embedder: its own I/O, GL context hooks, backing stores in
   plain memory, the implicit fence counters (`vtest_renderer_fences`);
8. the mixed-attachment probe with a sized format (WebGL rejects unsized
   `GL_RED`, and the pending error then refused every command);
9. sampler view swizzles applied in the shaders on a host without
   `GL_TEXTURE_SWIZZLE_*` (WebGL2), probed at init; the GL blitter takes the
   source format's swizzle into its shader;
10. `VIRGL_RENDERER_COARSE_GL_ERRORS`: GL errors checked once per command
    buffer instead of after each command (glGetError is a round trip in
    WebGL; every command of a buffer is one context's).
11. caps filled on context 0 and the current context forgotten when one is
    created (Measured, the two upstream bugs);
12. a query's state marked pending (`VIRGL_QUERY_STATE_WAIT_HOST`) in its
    buffer when the guest asks for the result: Mesa writes that into memory
    it shares with the host, which the inline dialect does not share, so
    the buffer kept saying DONE from the query's last use, and a read
    before the new result was in returned the old one (Busy waits);
13. vtest shares the renderer: with `VTEST_EXTERNAL_IO` the resource ids
    it hands out start at 0x40000000 (a virtio-gpu guest numbers its own
    from 1, in its command streams), and `vtest_renderer_add_fence()` adds
    an implicit fence for another user, as vtest's write_fence callback
    takes every context 0 fence for one of its own (The DRM path);
14. `PIPE_TEX_WRAP_CLAMP_TO_BORDER` as `GL_CLAMP_TO_EDGE` on a GLES host
    without border clamp (WebGL2 has none): the guest's Mesa offers
    OES_texture_border_clamp whatever the host can do, GTK 4's GL renderer
    samples with it from its first frame, and WebGL's INVALID_ENUM then put
    the context in error, so a GTK 4 window stayed blank; only lookups
    outside a texture differ (its edge texel instead of the border colour).
15. typed vertex inputs and colour outputs on WebGL: vrend declared every
    vertex input and fragment output as a float vector unless `use_integer`
    (by default only an ARM host), and on a host without
    vertex_attrib_binding never filled the vertex elements' integer masks;
    WebGL refuses a draw whose input type differs from its attribute's
    (`glVertexAttribIPointer`; "Vertex shader input type does not match the
    type of the bound vertex attribute") or whose output type differs from
    its colour buffer's. Now the masks are filled at creation and an
    emscripten host uses integer types. Firefox's WebRender draws with
    instanced `ivec4` attributes from its first frame: before, its context
    went into error at that draw, every later submit and transfer of it
    failed (the guest's kernel: `response 0x1200 (command 0x207)` and
    `(command 0x205)`, flooding), and its window stayed fully transparent
    (2026-11-22; `unkernel-check.mjs --drm` step h).
16. integer colour buffers cleared with `glClearBuffer{u,i}v`: a clear of
    every bound colour buffer was one `glClear`, which WebGL refuses for
    an integer buffer ("No defined conversion between clear value and
    attachment format": the context in error), and the per-buffer path
    tested the format of a truth value (`surf && surf->format`), so it
    never took them (step h's RGBA8UI clear).
17. multisample resources as multisample renderbuffers on a GLES host
    without multisample textures (`vrend_state.ms_renderbuffers`; WebGL2
    has renderbuffers with up to `MAX_SAMPLES` samples, no
    `GL_TEXTURE_2D_MULTISAMPLE`): before, no format could be multisampled
    and the texture_multisample cap was off, so the guest's Mesa offered
    no multisampling at all (`GL_MAX_SAMPLES` 1, one sample per format),
    Chromium's ANGLE capped itself at OpenGL ES 2.0 (ES 3.0 needs 4
    samples for every required renderable format) and Chromium, which
    asks for ES 3.0 only, rendered in software (web.md, Wayland desktop,
    Chromium). Formats whose renderbuffer takes `MAX_SAMPLES` samples get
    the multisample bit, the cap is set (Mesa offers multisampling only
    with it), attachments of such a resource are renderbuffer attachments,
    a blit the GL blitter must do (it samples its source) resolves the
    renderbuffer into a single-sample texture first, and the guest gets the
    standard sample positions (WebGL cannot tell them). Such resources can
    be rendered to, cleared and resolved (GLES 3.0 multisample
    renderbuffers, multisampled EGL configs, WebGL's antialias in a guest
    browser), not sampled: the cap also gives a desktop GL 2.1 context
    ARB_texture_multisample, whose `sampler2DMS` does not build on WebGL,
    and the unit stays empty; nor transferred (Mesa resolves first).
    Step m (`test/gpu/msaa.c`, 2026-11-22). The GL blitter's resolve
    path is not reached by any test.
18. a deleted-key marker that no id can equal in `util_hash_table`: its
    keys are ids cast to pointers (object handles, resource and context
    ids), and Mesa's hash table marks a deleted slot with a static
    variable's address, which on wasm32 is a small number (62592 in one
    build), so the object with that handle was never found. Mesa's virgl
    numbers objects from one counter, about one a frame for a KMS client,
    so glmark2-es2-drm's whole run failed in its 31st scene (`Illegal
    surface 62592`, then every draw of the context; 2026-11-22, the full
    run by `unkernel-check.mjs --drm --cmd`, 0 errors since). The marker
    is UINTPTR_MAX, refused as a key.
19. a host GL error drops a call, not the context: both builds set
    `-Dcheck-gl-errors=false`, and without it vrend logs such an error as
    an error (`GL error 0x502 in context N "name": the host dropped a call
    (K so far)`; the first eight, then each time the count doubles; a
    release build does not print warnings) and counts it
    (`vrend_renderer_host_gl_errors()`, `kw_vgpu_gl_errors()`, the SDK's
    `stats.glErrors`). WebGL refuses calls that GLES leaves undefined (a
    texture both sampled and rendered into, a texture of another type than
    its sampler, a vertex buffer too small for a draw), and with the checks
    fatal one such call put the context in error for good (Firefox's window
    went blank). `GL_OUT_OF_MEMORY` still puts the context in error, as do
    vrend's own checks of the guest's commands.

## Single GL context

`VIRGL_RENDERER_SINGLE_GL_CONTEXT` (vtest: `--single-gl-context` or
`VTEST_SINGLE_GL_CONTEXT`; patch 1) runs every renderer context, sub
context and the GL blitter on the GL context that `vrend_renderer_init`
creates. It lives in `vrend_renderer.c`, not in a winsys, so the web build
gets it with any winsys; the wasm module always sets it. It needs a GLES
host (on desktop GL it warns and keeps one context per sub context) and
ignores `VIRGL_RENDERER_THREAD_SYNC`.

`vrend_state.gl_owner` names the sub context whose state the GL context
holds. Every place that used to make a sub context's GL context current
calls `vrend_single_acquire`, which, when the owner changes:

- ends the old owner's active queries into a fresh GL query object (the
  result adds up, or ORs for boolean queries, the parts), its render
  condition, a running transform feedback, and its clip planes;
- resets to the GL defaults everything any sub context or the blitter
  changes (blend, colour mask, depth, stencil, scissor, cull, polygon
  offset, rasterizer discard, line width, depth clamp, clip control, sample
  mask and shading, program, transform feedback binding);
- emits the new owner's state: framebuffer and VAO bindings, transform
  feedback object, the last rasterizer state it bound (its `hw_rs_state`
  shadows forced), depth and stencil enables and depth function and mask
  from its shadows, colour mask from `hw_blend_state`, blend colour,
  viewports, depth ranges and scissors, sample mask and minimum sample
  shading (new shadows, as these were emitted once and never stored), and
  restarts its queries and render condition; texture units, samplers,
  uniform buffers, stencil functions and blend functions are marked dirty
  for the next draw or clear.

State every user binds before use is left alone: program (bound per draw
and clear), array, element, copy, indirect and uniform buffer bindings,
pixel store (each transfer sets and resets it), front face and primitive
restart (per draw). The blitter enters through
`vrend_renderer_single_enter_blitter` (owner released, defaults, texture
unit 0 with no sampler object, its VAO and buffer bound), and the client is
re-acquired after the blit. A sub context's creation releases the owner
before creating its objects; its destruction ends active transform
feedback and clears `gl_owner`. Fence checks no longer switch to context 0
in this mode (any context serves for sync objects).

Not covered, as no GLES 3.0 host has the feature: a split query used as a
render condition or read through a query buffer object counts only its
last part; transform feedback without TF objects (`transform_feedback2`);
desktop-only state (polygon stipple and clip plane equations in the
compatibility profile, tessellation default levels).

## WebGL2

The module renders through emscripten's WebGL2 bindings. What WebGL2 lacks
is made up at three levels, the shim first:

- `kw_gl.js` (JS library):
  - **Buffer types.** WebGL types a buffer at its first binding: an element
    array buffer can be bound nowhere else but the copy targets, nor the
    other way round, and the GPU cannot copy between the two kinds. Mesa's
    virgl streams vertices and indices through the same buffers, so vrend's
    buffers are never element buffers: binding one to
    `GL_ELEMENT_ARRAY_BUFFER` binds its element twin, made on first use.
    Data calls (`kw_glBufferData` and the rest; `epoxy/gl.h` renames vrend's
    calls) go to the buffer, through a copy target, and to its twin; a GPU
    write (buffer copy, transform feedback) marks the twin stale, and an
    indexed draw reloads a stale twin by reading the buffer back.
  - **Buffer maps.** `glMapBufferRange` is a copy in module memory (filled by
    `getBufferSubData` unless all of it is invalidated), written back by
    `bufferSubData` at unmap or flush: buffer upload and readback,
    stride-0 vertex attributes.
  - **Uniform buffer sizes.** WebGL refuses a draw whose uniform buffer
    range is smaller than its block (`UNIFORM_BLOCK_DATA_SIZE`), which
    desktop drivers allow and vrend passes on as the guest bound it.
    `kw_glBindBufferRange` rounds a uniform range up to 16 bytes (an std140
    block's size is a multiple of 16) and `kw_glBufferData` rounds every
    buffer vrend allocates the same way, so a range short of only its
    trailing padding draws: SuperTuxKart 1.4 (Matrices, 592 bytes in a
    584-byte buffer), whose context otherwise went into error at its first
    3D draw.
  - **Indexed blend and colour mask** on `OES_draw_buffers_indexed`, whose
    GLES name vrend's feature check finds in emscripten's extension list.
  - **Base vertex and base instance draws**:
    `WEBGL_draw_instanced_base_vertex_base_instance` when present (a draft
    extension: Chromium shows it only with `--enable-webgl-draft-extensions`,
    so not here), else every enabled array attribute is pointed that many
    elements further for the draw. Whether the check suite draws with a
    base vertex is not known.
  - `glFramebufferTexture3D(OES)` as `framebufferTextureLayer` (3D mipmaps
    through the blitter), `glGetQueryObjectiv`.
  - **Renderer name**: `glGetString(GL_RENDERER)` answers the unmasked name
    (`WEBGL_debug_renderer_info`) where WebGL says "WebKit WebGL", so the
    guest's renderer string, `virgl (...)` (vrend forwards GL_RENDERER in
    the caps, 63 bytes at most), names the WebGL implementation: here
    `virgl (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`.
- `epoxy/gl.h`: aliases (`glGetQueryObjecti64v`, `glQueryCounter` and others
  to emscripten's EXT names).
- vrend patches: the sized probe format (8), texture swizzles in the
  shaders (9), coarse error checks (10).

What the suite proved needed, by the error it hit first: the buffer maps
(every buffer upload), the element twins (glmark2's desktop scene binds a
vertex buffer as its index buffer), the swizzles (any RGBX texture),
`framebufferTextureLayer` (3D mipmaps), the clamped inline transfers
(below, Weston). Stale twins and buffer readback through a map ran through
no failing case.

`gl-missing.txt` lists what stays a stub (logs its first call, returns 0).
On a GLES host vrend reaches none of it in the check suite (no stub logged
in any run). What vrend could still reach: `glGetTexImage` and friends are
not called on GLES (vrend reports them missing and reads back only formats
`glReadPixels` can read; Mesa reads the others back through a blit, as the
caps' readback formats tell it), 1D textures (vrend skips them on GLES),
and everything behind features that are off.

Formats: BGRA is stored as RGBA with a red/blue swizzle, as on any GLES
host, which patch 9 makes work in WebGL; frames of BGRA X11 windows and
Weston's BGRA client buffers come out right.

Extensions WebGL2 has but vrend does not see, all unused by the check
suite and left off: `EXT_disjoint_timer_query_webgl2` (vrend looks for
`GL_EXT_disjoint_timer_query`; the entry points are aliased already),
`WEBGL_clip_cull_distance` (the shaders would need
`GL_ANGLE_clip_cull_distance`), `WEBGL_polygon_mode` (vrend has no GLES
polygon mode path), `WEBGL_stencil_texturing` (vrend wants GLES 3.1),
`WEBGL_multi_draw`. `EXT_clip_control`, `EXT_depth_clamp`,
`EXT_polygon_offset_clamp`, `EXT_texture_mirror_clamp_to_edge`,
`EXT_conservative_depth`, `NV_shader_noperspective_interpolation` and
`OES_draw_buffers_indexed` are seen under their GLES names.

Shaders: ANGLE's WebGL validator accepted every shader vrend and its
blitter wrote in the check suite (glmark2's 32 scenes, neverball, Weston,
the state clients); no compile or link failure was logged.

Inline transfers: Mesa's `TRANSFER_GET2` may ask for more than a
resource's backing holds (Weston's 500x400 client asks 819,200 bytes of an
800,000-byte backing); the native server does not check, and the module,
like vtest-bridge, copies what the backing has and pads the reply.

Fences and busy waits: Busy waits, below.

## Busy waits

A fence is a `glFenceSync` plus `glFlush` at submit (the implicit fence of
every `VCMD_SUBMIT_CMD`), retired by polling (`glClientWaitSync`, timeout
0). Without the sync thread vtest's `RESOURCE_BUSY_WAIT` with the wait flag
loops until no client has a fence in flight, and in WebGL a sync object
signals only between tasks, so that loop would never end.

What Mesa's vtest winsys (25.0, 26.2) waits for with the flag: after every
`TRANSFER_GET2` (protocol 2 and later), before it reads its memfd;
`resource_wait` before and after a readback and before mapping a busy
resource; `fence_wait` without a timeout: glFinish, glClientWaitSync,
drisw's swap (it finishes the frame's fence, then copies the back buffer
out with `TRANSFER_GET2` and waits again), the shader link sync; and a
query result read with wait. Without the flag a busy wait is a poll, which
vtest answers as ever.

Where a frame's time goes with vtest's answers (strict, below;
2026-11-21, `bridge-check.sh --wasm es2`, SwiftShader, the counters of
Stats): one parked wait a frame, drisw's fence wait before the readback
(3,052 parks for 3,053 readbacks, 4.5 ms each, 14.0 s of the run's 32.8
s), then 1.1 ms reading back the finished frame, 0.6 ms issuing GL; every
wait right after a readback is answered at once even so (its fence retired
during the park). With that wait answered at once the readback takes 3.3
ms: of the 4.5 ms park about 2.2 ms is the GPU drawing, the rest WebGL
telling late (probably Chromium's GPU process polling fences, and the page
seeing the result only in a later task; not examined) and the polling
(19 polls a park: 16 messages, then 1 ms timeouts).

Why an early answer cannot make the guest read data that is not valid: the
guest shares no memory with the GPU. Every byte it reads comes in a
`TRANSFER_GET2` (inline) or `TRANSFER_GET` (plain) reply, read with
`glReadPixels` or `getBufferSubData` (`kw_gl.js`, buffer maps), which
return only once the commands before them that write those bytes have run;
every byte it writes goes in with `TRANSFER_PUT(2)`, which GL orders after
the commands before it. The one result the host writes outside the command
stream, a query's (at fence retirement, `vrend_check_query`), reads as
pending until it is written (patch 12), and Mesa reads it again until then.
So the answer to a wait decides only timing: how far the guest runs ahead
of the GPU. `busy_wait()` in `kw_virgl.c` answers:

- at once, right after a `TRANSFER_GET(2)` of the same resource with only
  busy waits between: the reply carried the data;
- through vtest when the fences submitted before it have retired;
- at once, ahead of those fences, when the client's last answer ahead has
  retired or a `TRANSFER_GET(2)` of the client has come since (a read that
  waited for the GPU work it reads): a client runs at most one wait ahead
  of the GPU, and one that reads back every frame never parks;
- else it parks until the fences of that earlier answer have retired (the
  page polls `kw_virgl_poll` through a message for the first 16 rounds,
  then 1 ms timeouts), then answers ahead. A program that glFinishes in a
  loop without reading back is held one frame behind the GPU this way.

A parked wait waits for the fences submitted before it, not for all to be
idle, which matters with several clients, whose submissions would
otherwise keep it waiting. `KW_VIRGL_STRICT_WAIT` (`kw_virgl_open`;
`Renderer`'s `strictWaits`, the SDK's `gl.strictWaits`, the page's
`?glwait=strict`, the bridge page's `?wait=strict`, `bridge-check.sh
--strict-waits`) parks every waiting busy wait until the fences submitted
before it have retired, vtest's answer, for comparison.

Not taken: no capability bit makes Mesa skip a wait (the winsys waits
after every `TRANSFER_GET2` from protocol 2 on, drisw's fence wait is
unconditional); Chromium's WebGL `finish()` is a flush and WebGL allows no
`clientWaitSync` timeout but 0, so nothing completes a fence within a task;
prompter wake-ups for parks were left, as parks are rare (188 in the run
below, state and es2, mostly as scenes start, 0.5 s in all).

Measured (2026-11-21, `bridge-check.sh --wasm state es2`, SwiftShader, a
noisy shared host, one run each): state 60 of 60 frames match with either
answer; glmark2-es2 (800x600, 2 s a scene), vtest's answers (the build
before these rules) / these rules: build 121 / 153,
texture 128 / 168, shading 116 / 141, bump 125 / 169, effect2d 126 / 143,
pulsar 123 / 150, desktop 48 / 55, buffer 91 / 93, ideas 64 / 74,
jellyfish 83 / 96, terrain 12 / 12, shadow 92 / 101, refract 31 / 33,
conditionals 123 / 156, function 124 / 155, loop 124 / 147. 3,766
readbacks in the run instead of 3,053: 3.35 ms reading back, 0.61 ms
issuing GL and almost nothing parked per readback; the renderer was busy
about 47% of the run, the rest is the client side (Mesa, the bridge, the
WebSocket carrying 1.2 MB a frame back, Xvfb). Two more pairs, default /
`--strict-waits` alternating, with the host loaded by others (load 6 to
10): 3,447 / 2,500 and 3,114 / 1,954 readbacks in the 32 s of es2; build
142 / 107 and 143 / 86, jellyfish 88 / 76 and 84 / 70.

### Stats

The module counts, over all clients since init (virtio-gpu's commands
too: SUBMIT_3D as a submit, TRANSFER_FROM_HOST_3D as a read,
TRANSFER_TO_HOST_3D as a write; `kw_virgl_stats()`,
`KW_VIRGL_STAT_*` in `kw_virgl.h`; `Renderer.totals()` adds the polls by
message and by timer; the SDK's `vm.gl.stats.renderer`, `VirglTotals`):
commands by kind with the time each took, GL calls included (submits,
reads = readbacks, writes = uploads, others), the waiting busy waits and
how each was answered (`waitsRead`, `waitsDone`, `waitsAhead`, `parks`),
time parked and the longest park, and polls. Two `emscripten_get_now()`
calls a command: cheap enough to leave on (with vtest's answers, es2 ran
within noise of the build without counters: 119 / 121 build, 84 / 83
jellyfish). The page's Guest GL row
(web.md, Guest GL) shows, over the last 2 s with readbacks, readbacks a
second and per readback the time parked, reading back, issuing GL and
uploading, how busy the renderer was, and how the waits were answered; the
bridge page logs the totals when a client closes.

Reading them on a GPU: parked per readback near 0 and `waitsAhead` about
one a frame is the expected state. Parked time with `waitsAhead` low means
waits the rules hold (a client that waits twice without a readback) or
`?glwait=strict`. A high reading-back time is the GPU's frame plus the
copy of the frame out (`glReadPixels` of 800x600 RGBA is 1.9 MB,
synchronous); its lever would be a pixel pack buffer read after a fence,
or not reading back at all (frames to the page's display). A high issuing
time is per-draw cost in emscripten and WebGL (desktop, ideas). A renderer
busy for a small share of the frame interval means the frame time is
outside it: the guest's Mesa under kwemu, kwvsock carrying the frame, Xvfb.

## Measured (2026-11-21, Fedora 44 container, no GPU)

Native: host GL llvmpipe (Mesa 26.2.7), surfaceless EGL, held to GLES 3.0
with 41 extensions that WebGL2 lacks disabled. Browser: headless Chromium,
WebGL 2.0 on ANGLE/SwiftShader (`--use-angle=swiftshader
--enable-unsafe-swiftshader`). Clients: Mesa's virgl driver over vtest
(`GALLIUM_DRIVER=virpipe`) on Xvfb, unmodified.

- The guest side reports GLES 3.0 and GL 2.1 on both renderers.
- **The wasm renderer passes the whole suite** (`bridge-check.sh --wasm`):
  info, es2 and gl (all 16 scenes each), sdl, weston, multi and state, no
  unexpected line in the page's log, frames looked at (every glmark2 scene,
  neverball's menu, Weston with a client, six clients at once). state's 60
  frames equal those of the same clients run alone on a second page; against
  the native multi-context renderer 51 checksums differ, by rounding
  (SwiftShader against llvmpipe; no pixel differs by more than 2%).
- FPS through the same bridge and page, wasm renderer against the relay to
  the native server (shared, noisy host; one run each): glmark2-es2 build
  90 / 115, texture 107 / 136, shading 87 / 105, desktop 37 / 80, ideas 61
  / 111, jellyfish 84 / 117, terrain 12 / 16, shadow 95 / 84, refract 27 /
  24, loop 124 / 122. Most scenes 0.75 to 1.1 of the relay; desktop and
  ideas, with many small draws, about half. Before patch 10, ideas ran at 6
  (three glGetError round trips a draw). Native without the bridge is 2 to 3
  times the relay.
- **One GL context needs state handling.** Every context on one GL context
  with nothing restored passes the screenshot tests with `--fork`, where no
  two clients share a renderer, but with one server process the `state`
  test fails (36 of 44 frames differ, queries count other clients'
  samples). With the single GL context mode all 60 frames match in every
  run; disabling any one part of its restore makes frames differ.
- **Two upstream bugs of a server that all clients share** (unpatched
  1.3.0 with `--no-fork`, any host GL) broke the client that drew last,
  seen as GL_INVALID_FRAMEBUFFER_OPERATION in Weston when a Wayland EGL
  client started: `vrend_renderer_fill_caps` ran its framebuffer probes on
  whichever GL context was current and left framebuffer 0 bound, and
  `vrend_create_context` made the new GL context current while the previous
  client stayed recorded as current. The series fixes both (caps on context
  0; a created context clears the current one). In WebGL the first would
  have drawn into the canvas with no error.
- Those features WebGL2 lacks that Mesa's llvmpipe cannot hide
  (`MESA_EXTENSION_OVERRIDE` disables every always-on extension with any
  one of them) were only testable against the real WebGL2, above.

From the source (1.3.0): GL contexts are created in
`vrend_renderer_create_sub_ctx` and switched through
`vrend_clicbs->make_current`; GL is reached through libepoxy; the vtest
server (`vtest/`) uses fork or threads, unix sockets, memfds and an
eventfd. vtest forks one server process per client unless given
`--no-fork`, also with `--multi-clients`; only `--no-fork` puts several
clients on one renderer, as the page does.

### unkernel (2026-11-21, `unkernel-check.mjs`, headless Chromium 157)

The guest is Debian 13 on the UP kernel (inline; worker mode passes (a)
and (b) the same), 1024 MiB, the prepared disk. The WebGL2 is ANGLE on
SwiftShader (software: every virgl number is a floor for a page with a
GPU). One run each, on the shared host:

- `vm.gl.ready` 0.6 s after the page started (boot, module, forwarder
  linked); `eglinfo -B -p surfaceless` on virgl 1.5 s: `virgl (ANGLE
  (Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`, GLES 3.0 and GL 2.1
  (Mesa 25.0.7).
- `kwgl-state` (7 clients, 8 turns, 64x64): all 60 checksums of the
  interleaved run equal each client's alone in the guest, and equal the
  host's own run of the same clients through `bridge-check.sh --wasm
  state` (x86 Mesa 26.2.7, the same renderer): the pixels are the
  renderer's, whatever carried them. On llvmpipe in the guest 52 of 60
  differ (rounding, as against the native renderer). 3.2 s on virgl, 32.4 s
  on llvmpipe.
- glmark2-es2 under Xvfb at 640x480, 10 s a scene, the same command with
  and without `GALLIUM_DRIVER=virpipe` (FPS from glmark2's mean frame time):

  | Scene | virgl (WebGL2 on SwiftShader) | llvmpipe (in the guest, under kwemu) | Ratio |
  | --- | --- | --- | --- |
  | build | 93.2 | 4.30 | 22x |
  | texture | 98.8 | 4.08 | 24x |
  | shading (phong) | 91.9 | 0.82 | 112x |
  | jellyfish | 69.8 | 0.32 | 218x |
  | desktop | 38.2 | 0.16 | 239x |

  virgl here is as fast as Mesa on this host through the bridge's
  WebSocket to the same renderer (Measured, above: build 90, texture 107,
  jellyfish 84, desktop 37, also 640x480, 2 s a scene): the browser's
  renderer bounds it, not the emulated guest or kwvsock. Each frame comes back to the guest
  by readback and goes to Xvfb by XPutImage, for virgl and llvmpipe alike.
- The prepared disk: 290 MiB used of a 4 GiB sparse image; made in 55 s
  (boot, apt over the direct network, power-off).

## Work packages

1. **Single context, hardened (native).** Done: Single GL context. Check:
   `test/gl/vtest-check.sh --single`.
2. **Emscripten build.** Done: `gl/wasm`. Check: `node gl/wasm/test/check.mjs`.
3. **WebGL2 gaps.** Done for everything the check suite exercises: WebGL2.
   Next, by what real programs would hit: timer queries, clip and cull
   distances, polygon mode through the WEBGL extensions; dEQP and piglit
   (below) would find the rest.
4. **Bridge and browser harness.** Done: `gl/bridge`, `bridge-check.sh`
   (relay or `--wasm`).
5. **unkernel.** Done: unkernel, below. Check: `node test/gl/unkernel-check.mjs`.
   The page's option: done (The page). Check: `node test/gl/page-check.mjs`.
   Next: frames to the page's display under X on kwfb (unverified); Wayland
   clients show on the page through wland (item 6). Busy waits: done (Busy
   waits).
6. **virtio-gpu 3D.** Done: The DRM path, in the page by default (The
   page), the renderer loaded on first use, window images (`image()`) for
   wland's relay mode, which the page uses (web.md, Wayland desktop). Check:
   `node test/gl/unkernel-check.mjs --drm`; the page's Wayland GL windows:
   `node test/wland/page-check.mjs --built --gpu`.

## unkernel

`createKernel({ gl: true })` (js.md, Guest GL; README.md):

- **Host** (`js/core/gl.ts`): on the thread that owns the VM, in both
  modes (vsock is served there: in worker mode the kernel's worker only
  passes packets), `StreamHost` (`js/core/gl-stream.ts`) serves every
  connection to vsock port 1019 from the boot on, and the renderer
  (`GlLoader`: the module imported from `new URL("./virgl.mjs",
  import.meta.url)` of the web entry, dist/virgl.mjs and virgl.wasm copied
  by `pnpm build`, never fetched without `gl`; `Module.virgl.Renderer` on a
  1x1 OffscreenCanvas's WebGL2) is loaded on the guest's first GL use
  (Loading on first use). Node: ignored with a log line (no
  OffscreenCanvas), unless `gl.renderer` gives a renderer object (the
  relay works there).
- **Guest** (`kwbox vtest`, kernel/guest.md): the bridge
  built stream-only, in the base's kw layer (in the bundle, so it always
  matches the SDK that speaks its link; 12 KB of the layer's kwbox,
  RAM-resident for every distro, Alpine included, which cannot use it;
  67 KB as a program of its own). The SDK starts it
  through kwtty as root once the renderer is up (`bridge --link
  vsock:2:1019 --daemon`); it makes `/tmp/.virgl_test` mode 0666 when the
  host sends READY (at once: the renderer is not needed for that), and
  `vm.gl.ready` resolves on its LOG line saying so.
- **Mesa**: not in the image; `apt-get install mesa-utils libegl-mesa0
  libgles2` (surfaceless, about 45 MB download), plus `libgl1-mesa-dri
  libglx-mesa0 xvfb xauth glmark2-es2-x11 glmark2-x11` for X11 (all of it:
  72 packages, 60 MB download, 238 MB installed). Debian trixie's Mesa
  25.0.7 has virpipe. Clients run with `GALLIUM_DRIVER=virpipe
  LIBGL_ALWAYS_SOFTWARE=1`, surfaceless or under Xvfb; without
  `GALLIUM_DRIVER` the same programs run on llvmpipe in the guest.
- **Snapshots**: renderer state is not saved. A restore resets the link
  (GL clients in the guest end); the restored guest's forwarder
  reconnects within a second and the new host's start of it exits 0.
  Verified on Node with the relay renderer (2026-11-21): eglinfo on virgl
  before the snapshot and after the restore, the same forwarder process.
- Alpine's Mesa has no virgl driver: Debian only.

## The DRM path

A real `/dev/dri` now exists: the stock virtio_gpu driver runs over
kwvirtio, a virtio transport whose registers are host imports
(kernel/devices.md), against the SDK's device model
(`js/core/virtio-gpu.ts`, `createKernel({ gpu })`, CLI `--gpu`). With
`gl` too, in a browser, the device has 3D: stock Debian Mesa picks its
`virtio_gpu` (virgl) driver on `renderD128` and `card0` with no
environment variables, and renders through the same wasm renderer and
WebGL2 context as the vtest path (js.md, virtio-gpu 3D, has the SDK side).
The kernel side is the stage 1 driver with nothing added; the base's rc
gives the DRM nodes udev's groups and modes (kernel/guest.md).

- **Discovery**: libdrm's `drmGetDevice2()` takes the platform device
  `kwvirtio.0` without an OF node (bus type platform, name from the
  MODALIAS), and Mesa's loader, finding no PCI ids, takes the driver name
  from DRM_IOCTL_VERSION: "device is not located on the PCI bus", "using
  driver virtio_gpu". GBM, EGL on gbm and surfaceless all find it.
- **Options**: `gl` is the renderer (and the vtest link), `gpu` the device;
  both, where `gl` gets WebGL2: the device offers VIRTIO_GPU_F_VIRGL and
  two capsets, whose contents are read from that WebGL2 context (their
  ids, versions and sizes are constants; Loading on first use). Not CONTEXT_INIT: with it
  the driver makes a file's context only on DRM_IOCTL_VIRTGPU_CONTEXT_INIT
  or first 3D use, and a PRIME import made before that is never attached
  to it (the renderer then refuses transfers of that resource as an
  illegal resource of that context); without it every resource a file
  opens is attached. The driver probes the features and asks for the
  capsets' ids, versions and sizes (GET_CAPSET_INFO) at boot, which the
  device answers without the renderer; a capset's contents (GET_CAPSET)
  are asked by the first `DRM_IOCTL_VIRTGPU_GET_CAPS` (Mesa's screen
  creation) and cached by the kernel per id and version.
- **Renderer front end** (`kw_virgl.c`, `kw_vgpu_*`): the virtio-gpu control
  commands mapped to virglrenderer's API as QEMU's
  `hw/display/virtio-gpu-virgl.c` maps them (context create with flags,
  destroy, attach and detach resource, RESOURCE_CREATE_3D, unref,
  TRANSFER_TO_HOST_3D and FROM_HOST_3D through `transfer_write_iov` and
  `transfer_read_iov`, SUBMIT_3D), plus the capsets
  (`get_cap_set`/`fill_caps`), a format table, fences, `resource_get_info`,
  present and read. Context ids are the guest's plus 0x40000000; resource
  ids are the guest's (they are in its command streams), and vtest's own
  start at 0x40000000 (patch 13), so both paths run at once. 2D (dumb)
  resources stay with the SDK's 2D model.
- **Memory, copies**: the guest's pages are in the kernel's memory, the
  renderer's in its own; no resource is shadowed. No resource gets an
  iovec in the renderer (ATTACH_BACKING stays with the device side), and
  the guest's capsets lose VIRGL_CAP_TRANSFER and VIRGL_CAP_COPY_TRANSFER
  (and COPY_TRANSFER_BOTH_DIRECTIONS, MEMINFO, RESOURCE_LAYOUT), so Mesa
  moves data with the transfer ioctls only: there are no transfers inside
  the command stream (VIRGL_CCMD_TRANSFER3D, COPY_TRANSFER3D: those read
  and write a resource's iovec, which is guest memory in QEMU and would be
  a stale shadow here) and no staging resources. A transfer's bytes are
  packed on the device side (each block row of the box, layer after layer;
  a buffer's range) and the command rewritten to offset 0 and the packed
  strides: an upload is one copy inline (guest pages into the module's
  heap), two in worker mode (pages into a transferred buffer, it into the
  heap); a readback is one copy out of the heap (plus the transfer in
  worker mode) and a row-by-row scatter, so bytes between rows stay the
  guest's. Query results (VIRGL_BIND_CUSTOM buffers) live in host memory
  (vrend's `res->ptr`), which patch 12 marks pending when asked and
  readbacks read.
- **Fences** (`GpuRenderer`): a fenced command's answer is its fence
  signal. Busy waits' reasoning holds (the guest shares no memory with the
  GPU; what it reads comes in a TRANSFER_FROM_HOST_3D answer, read after
  the work before it; queries read pending until written), so the answer
  decides only timing: at once by default, except that after a frame was
  presented (RESOURCE_FLUSH of the scanout) a fenced command waits until
  that frame's work is done, so a KMS client runs at most about a frame
  ahead of the GPU; readbacks at once. `gl.strictWaits`: each once its own
  work is done (QEMU's). Fences are vtest's implicit ones (one sequence on
  the one GL context; `vtest_renderer_add_fence`). Unfenced commands that
  only answer OK are answered by the device at once and posted.
- **Presentation**: a KMS client's framebuffer is a 3D resource; SET_SCANOUT
  of it gives the display its mode with no pixels, RESOURCE_FLUSH blits its
  texture into the renderer's OffscreenCanvas (sized to the scanout;
  `kw_vgpu_present` gives vrend's single GL context up first, as its
  blitter does, so the next command restores the client's state; it is
  `kw_vgpu_blit` with alpha set to 1 after the blit, as the drawing buffer
  has alpha for window images, below) and takes
  it with `transferToImageBitmap()`; `vm.gl.gpu.drawFrame(ctx)` draws that
  into the page's 2D canvas (Display.tsx does, per animation frame, in both
  modes; the renderer is on the page's thread either way). No `readPixels`
  on that path; `vm.frame()` reads the scanout back (screenshots). The
  texture's row k is the picture's row k (from the top, as the guest lays
  it out), or for a VIRGL_RESOURCE_Y_0_TOP resource its row height - 1 - k
  (vrend inverts transfers of such a resource); the blit flips the first
  kind.
  Page flips are paced by virtio-gpu's emulated vblank (60 Hz).
- **Display size**: the connector's preferred (and only) mode is the
  display option's size (the page: its Display window's box), from the device's EDID.
  `vm.updateDisplaySize()` (the page calls it 300 ms after that box last
  changed) gives a running guest a hotplug with the new mode
  (kernel/devices.md, js.md); the display and the page's canvas follow
  the mode a client sets, never the size asked. Who switches: KMS
  clients that read netlink uevents themselves (`test/gpu/kms-hotplug.c`);
  kmscube and glmark2-es2-drm at their next start; X only by `xrandr`
  (a plain `xrandr` probes, then `xrandr --output Virtual-1 --auto`; a
  bare `--auto` turned the output off, 2026-11-22), since its modesetting
  driver hears hotplugs from udev, which the guest has not: the X + glamor
  app (`apps/xkms.ts`) runs a follower (perl on netlink, then those two). No fbdev
  emulation on DRM (DRM_FBDEV_EMULATION is off); kwfb takes a new size at
  its next first open.
- **dmabuf**: PRIME export and import between openers of the device is the
  stock driver's self-import (no vmap); `DRM_IOCTL_VIRTGPU_RESOURCE_INFO`
  gives the resource id, `vm.gl.gpu.texture(id)` its `WebGLTexture` in
  the renderer's context, and `vm.gl.gpu.image(id, opts)` its picture as
  an ImageBitmap for a compositor on the page (textures do not cross WebGL
  contexts, images do; js.md). The page's Wayland desktop shows GL
  clients that way: wland's relay (`--dmabuf virtgpu`) names each client
  buffer by its resource, and the page's `gpu.resolve()` is `image()`
  (web.md, Wayland desktop, which has what Mesa picks and the numbers).
- **Window images** (`image()`): `kw_vgpu_blit` (inside the module, as
  present: vrend's state handled the same way) copies the resource's
  rectangle into the drawing buffer, sized to it, and
  `transferToImageBitmap()` takes it: no readback. Row 0 is the picture's
  top row as the guest lays it out (Y_0_TOP or not, as present), or its
  last with `flipY` (wland's y_invert flag, which the resolver honours);
  colour and alpha go as the client rendered them, so a Wayland client's
  premultiplied ARGB stays premultiplied (what a premultipliedAlpha drawing
  buffer and drawImage() of an ImageBitmap take), and `opaque` (by default
  for a format without alpha; the resolver passes it for XR24 and XB24)
  sets alpha to 1 after the blit (an X format's fourth byte is whatever
  the texel holds: blitted raw it showed). For that the renderer's WebGL2
  context has `alpha: true` (premultiplied, no preserveDrawingBuffer);
  with `alpha: false` every image was opaque. Chosen over a second canvas
  (a context has one) and readback (the point); the cost is a clear of the
  alpha channel per presented frame. Every blit starts with a full clear:
  WebGL clears a drawing buffer lazily before the first draw or clear
  after it was taken or resized, a blit does not trigger that, and
  Chromium folds it into the next clear, so the masked alpha clear wiped
  the blitted colour (opaque black images, and black scanout frames right
  after an image) until the blit came after a clear. The drawing buffer is
  resized to each image and back by the next present; nothing is lost, as
  each present blits the whole scanout and its frame is already an
  ImageBitmap (about 1.4 ms per resize on SwiftShader, below). A module
  without `blit` keeps `alpha: false`, and `image()` gives null. Each blit
  ends by clearing pending GL errors (logged as `kw_virgl: blit of
  resource N: GL error ...`): with errors checked once per command buffer
  (patch 10) one left there, or by a transfer, which vrend does not check,
  was charged to the next client's command buffer (counted and logged as
  that context's, patch 19).
- **Snapshots**: refused while any 3D resource exists or a context has
  submitted commands (its objects, shaders, states, sub contexts, live
  only in the renderer), before the guest parks; the page says a program
  is using the GPU. A context that never submitted, with no resource
  attached (none exists), is let through: a Wayland relay that imported
  clients' buffers and closed them keeps such a context for its DRM file.
  The renderer loses only its id; the restored guest's kernel still has
  it, and the device side makes it again (CTX_CREATE, no debug name) on
  the first command that names a context it did not see made. Without
  that, a transfer through the old context after the restore failed in
  the renderer while the guest saw no error (`--snapshot`, checked both
  ways, 2026-11-22).
- WebGL warnings in the page's console when the renderer loads (any
  client's first GL use; 2026-11-22, SwiftShader): about 50 `texImage2D:
  invalid internalformat` / `invalid format` and one `texParameter:
  invalid parameter name` are vrend's probes, not errors: its format table
  (`vrend_formats.c`, a 32x32 `glTexImage2D` of each format; the ones
  WebGL refuses are left out of the caps, so the guest is never offered
  them; fewer on a GPU with more WebGL extensions) and the
  `GL_TEXTURE_SWIZZLE_R` probe of patch 9.
- Not done: blob resources and host-visible memory (no coherent buffer
  maps), Venus, dumb buffers used by 3D contexts, the cursor plane (taken
  and ignored). On
  SMP only a short check: `page-check.mjs --cpus 0` (the page's default, 4
  CPUs, worker mode; 2026-11-21) ran `eglinfo -B -p gbm` on virgl and
  kmscube at 55 to 57 fps; the 2D device: `test/gpu/check.mjs --cpus 2`.
- Guest notes: kmscube
  and glmark2-es2-drm stop at the first byte or EOF on stdin, so give them
  a stdin that stays open (`mkfifo /tmp/h; exec 3<>/tmp/h; kmscube <&3`).
  glmark2-es2-drm 2023.01 draws at the mode's size and never makes its
  window when `-s` equals the mode or with `--fullscreen` (a size check in
  its CanvasGeneric), and its first config is RGB565, which its
  drmModeAddFB(24, 32) refuses: run it without `-s` and with
  `--visual-config red=8:green=8:blue=8:alpha=0`. The kernel refuses
  strides in a TRANSFER_TO_HOST of a resource that is not a blob (Mesa
  sends none; the host takes the level's).

### Measured (2026-11-21, `unkernel-check.mjs --drm`, headless Chromium 157)

Debian 13 on the UP kernel with kwvirtio (the default bundle), 1024
MiB, display 640x480 (60 Hz), the prepared disk, WebGL2 on ANGLE/
SwiftShader (software: a floor); one run each on a shared host.

- No GL variables: `eglinfo -B -p gbm` and `-p surfaceless`: `virgl (ANGLE
  (Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`, OpenGL ES 3.0 Mesa
  25.0.7; libdrm's `drmdevice`: bus type platform, name `kwvirtio`, nodes
  card0 and renderD128.
- kmscube (600 frames): 59.9 to 60.0 fps, the vblank timer's rate; 601
  presents, about 600 drawn into the page's canvas; three frames sampled
  from the canvas (4096+ colours, the cube) equal the scanout read back in
  the same task pixel for pixel, inline and in worker mode.
- glmark2-es2 at 640x480, 5 s a scene, the DRM path (glmark2-es2-drm, which
  swaps in mailbox mode: frames render as fast as they can, at most 60 a
  second are flipped) against the vtest path (glmark2-es2 under Xvfb with
  virpipe, each frame read back and put to Xvfb), FPS from the mean frame
  time:

  | Scene | DRM | vtest | DRM, `--off-screen` | vtest, `--off-screen` |
  | --- | --- | --- | --- | --- |
  | build | 541 | 121 | 781 | 488 |
  | texture | 649 | 132 | 1333 | 646 |
  | shading (phong) | 309 | 111 | 403 | 318 |

  Off screen (nothing presented or read back) the DRM path is 1.3 to 2.1
  times the vtest link: the same renderer, without vtest-bridge, kwvsock
  and the inline transfers in the stream.
- kwgl-state's 60 frames on the DRM path (surfaceless EGL on the render
  node, its occlusion query included): all equal each client alone and
  the same clients on the vtest path; 3.3 s against 3.0 s.
- PRIME (`test/gpu/prime.c` as the default user): exporter and importer
  name the same resource; `vm.gl.gpu.texture()` finds its 64x64 texture
  with the importer's upload in it.
- Window images (2026-11-22, step g, inline and worker mode):
  `window-image.c`'s GBM window surfaces on Mesa's virgl are B8G8R8A8
  (ARGB8888) and B8G8R8X8 (XRGB8888), neither Y_0_TOP; Debian's Mesa has
  no EGL config for ABGR8888 or XBGR8888 on GBM. Every image (default,
  `opaque` as the fourcc says, `flipY`, a cropped quadrant) composited over
  black and white is exact: premultiplied translucency, X opaque, the top
  row at the top. kmscube's frames, drawn plain and over white, equal the
  scanout read back while images are taken between presents. Per image
  (image(), drawImage() into a 2D canvas, close(); 100 in a row, the GPU
  waited for at the end): 800x600 7.0 ms, 1920x1080 28.5 ms (without the
  drawImage 6.9 and 26.4); alternating the two sizes (a resize each) 19.3
  ms; with the scanout at 640x480 between them about 10 ms for a 64x48,
  a 1920x1080 and a 64x48. Nearly all of it is `transferToImageBitmap()`
  waiting for SwiftShader's blit: a plain WebGL2 OffscreenCanvas doing a
  clear, a blit of a texture of that size and the transfer takes the
  same (6.6, 26.3 ms), while its clear and transfer alone take 1.1 and
  4.3 ms. readPixels of the same textures is 0.7 and 2.6 to 4.0 ms
  here (SwiftShader's blit is slow, its readback a copy); on a GPU the
  blit is the cheap side. Not measured on a GPU.

## Loading on first use

The renderer (module and WebGL2 context) is loaded on the guest's first GL
use, not at boot (`GlLoader`, gl.ts): the first vtest client (an OPEN on
the forwarder's link: `LazyVtestRenderer` notes it and holds its bytes,
and StreamHost reads no more of the link meanwhile, so vsock credit holds
the forwarder), or virtio-gpu's first GET_CAPSET or 3D command (3D resource, submit;
`VirglGpuBackend` calls `GpuLink.start()`, in worker mode the message
`gpu-start`). A 2D client never loads it: with virgl the driver makes a
DRM file's context at its first dumb buffer too (CTX_CREATE, then
CTX_ATTACH_RESOURCE of each 2D resource it opens, CTX_DETACH and
CTX_DESTROY at the exit; no 3D resource), so before the load CTX_CREATE
is held (`#pending`) and made in the renderer when it loads, before the
command that loads it; attach and detach of a 2D resource, the destroy of
a context the renderer never got, and SET_SCANOUT 0 and RESOURCE_FLUSH
before any 3D use are answered without it (`test/gl-gpu.test.ts`; the
page check's case R, `kms-hotplug`). Commands
wait meanwhile: GET_CAPSET for the capsets, a 3D transfer for the format
table, and sends after a waiting one queue behind it. `gl.eager` loads it
before the boot instead (the page's `?glload=eager`).

- **Capset info without the module**: GET_CAPSET_INFO is answered from
  `VIRGL_CAPSETS` (gl-gpu.ts): VIRGL (1) version 1, 308 bytes, VIRGL2 (2)
  version 2, 1408 bytes, which are virglrenderer's constants
  (`VREND_CAPSET_*_MAX_VERSION`, `sizeof(struct virgl_caps_v1/v2)`;
  `virgl_renderer_get_cap_set()` "may be called before
  virgl_renderer_init"). Kept in step three ways: `kw_virgl.h` has the
  same numbers and `kw_virgl.c` `_Static_assert`s the sizes against
  virglrenderer's structs (a virglrenderer whose caps grew fails to build);
  `gl/wasm/test/check.mjs` checks the module's capsets against the SDK's
  table; `GpuRenderer` checks them when it loads the module and refuses a
  mismatch (no 3D, logged) rather than give a capset of another size than
  the driver cached.
- **Before the boot**: only a WebGL2 context is made and dropped
  (`probeWebGl2()`, `WEBGL_lose_context`; 5 to 6 ms in headless Chromium on
  SwiftShader), so that a browser without one gets the 2D device instead
  of a 3D one that fails at first use; a restore skips it (the snapshot's
  negotiated features decide).
- **The kernel's wait**: the first GET_CAPS waits for the load. Upstream
  waits 5 s and then gives -EBUSY, which Mesa takes for no caps (software
  rendering), although the answer comes later and serves every later
  client; kernel patch 0048 waits 30 s, killably. With `virgl.mjs` held 8 s
  (`unkernel-check.mjs --drm --gl-delay 8`) the first `eglinfo -B -p gbm`
  took 9.6 s and got virgl.
- **Failure**: if the module or the WebGL2 context fails at first use,
  every 3D command is answered ERR_UNSPEC (the kernel logs `response
  0x1200 (command 0x...)`), GET_CAPSET included, which the driver caches as
  a zeroed capset (it copies the reply's data whatever its type). Debian's
  Mesa 25.0.7 then gets no virgl screen and EGL falls back by itself
  (`libEGL warning: egl: failed to create dri2 screen` on surfaceless):
  `eglinfo -B -p gbm` and `-p surfaceless` report llvmpipe (LLVM 19.1.7,
  GLES 3.2), kmscube runs on llvmpipe with dumb buffers (17 to 18 fps),
  and a dumb-buffer KMS client (`test/gpu/kms-dumb.c`) works; vtest
  clients are closed (their socket ends). With no WebGL2 context at the
  probe the device is 2D (`-virgl`, 0 cap sets) and Mesa uses kms_swrast
  and llvmpipe from the start, without kernel errors. `ready` rejects then
  (the page's row says why). Checked 2026-11-21, `unkernel-check.mjs --drm
  --fail --glfail module` and `--fail --gl-flags "--disable-gpu
  --disable-software-rasterizer"` (the flags that make headless
  Chromium 157 give no WebGL2 context; `--disable-webgl` does not).
- **Snapshots**: the device offers the same features and capsets whether
  the renderer was loaded or not, so a session's device set does not
  depend on it; a guest that never used GL resumes as before, and loads
  the renderer on its next first use. A guest's kernel keeps the capset
  contents it cached, read from the WebGL2 of the page that saved it.

Measured (2026-11-21, `unkernel-check.mjs --drm --skip a,b,c,d,e`, inline
mode, the module from 127.0.0.1, SwiftShader, 5 boots each, medians):
`createKernel()` resolved after 98 ms lazily and 179 ms eagerly,
`vm.gl.ready` (the guest's forwarder linked) after 512 / 604 ms, the
first exec after 588 / 688 ms; the load itself took 105 to 231 ms (fetch,
compile, WebGL2 context, renderer init) and 80 to 100 ms on first use.
Over a network the fetch dominates: `virgl.wasm` is 155 KB brotli
(184 KB gzip), `virgl.mjs` 30 KB gzip.

## Context loss

The browser may drop the renderer's WebGL2 context: a GPU reset or driver
crash, the GPU process ended (WebKit marks every context of a GPU process
that went away lost, jetsam included; Chrome after a GPU process crash),
memory pressure, more than 16 contexts (the oldest goes; 4 in a worker),
`WEBGL_lose_context`. Every object the guest made lives only in that
context and the module instance that used it, so it cannot be had back.
Decided: a new renderer for new programs (level 1, below); nothing tells
the guest, and nothing is replayed.

What the guest can do about it (sources read 2026-11-22):

- Mesa 25.0.7's virgl keeps nothing to replay (objects are encoded into
  command buffers and forgotten), sets neither `get_device_reset_status`
  nor `set_device_reset_callback` (`src/gallium/drivers/virgl`; its only
  robustness cap is `robust_buffer_access_behavior`), so
  `glGetGraphicsResetStatus` never reports a reset on virgl and
  GL_KHR_robustness clients (Chromium, Firefox, GTK) never recreate their
  contexts for it. Its DRM winsys ignores failures: an EXECBUFFER error is
  a debug print ("got error from kernel - expect bad rendering"), the
  transfer ioctls' results are dropped.
- The kernel driver: an error answer is a rate-limited `response 0x1200
  (command 0x...)`, the fence is signalled all the same, and the ioctl
  returned long before. Nothing in the tree acts on
  VIRTIO_CONFIG_S_NEEDS_RESET (only its define); `config_changed` handles
  only VIRTIO_GPU_EVENT_DISPLAY; the PM restore path makes only non-virgl
  objects again (`virtio_gpu_object_restore_all`: "store non-virgl object
  ... to the restore list"), and hibernation is refused with virgl ("S4 not
  allowed when VIRGL is enabled"). So no device-side signal makes the guest
  notice, let alone rebuild.

Levels: (1) a new renderer that new programs use: done. (2) Making the
guest notice would take a kernel change: a host request that unbinds and
rebinds the device (remove: `drm_dev_unplug`, open DRM files get -ENODEV
and their programs fail; probe again: the nodes come back, maybe as new
minors while old files are open), which ends every user of the device,
2D ones (fbcon, X without glamor, compositors) included, and gives no state
back; or a new event and a Mesa change (unmodified Mesa is the rule). Not
done. (3) Replay: rebuilding a context needs every object its command
streams made (shaders, states, views, surfaces, sub contexts, queries),
so the host would record and replay each context's whole command history,
and what the GPU wrote (render targets, transform feedback, query results)
exists only in the lost context. The cheap part, uploading 3D resources
again from their guest backing (the device side keeps it), brings back
only what the guest last uploaded, which no program can use without its
context's objects: not done.

What happens (gl.ts `GlLoader`, `LazyVtestRenderer`; gl-gpu.ts
`GpuRenderer`):

- **At the loss**: the loader and the device each log a line; the event's
  default is prevented (so the browser may restore it). The vtest link
  closes every client (its Mesa sees the socket end). virtio-gpu answers
  every command at once without a GL call: ERR_UNSPEC (fenced ones too:
  the kernel signals the fence), OK for destroy, unref, detach, scanout
  and flush; waits for GPU work end, the scanout is cleared, `image()` and
  `texture()` give null. Contexts that submitted and every 3D resource
  become stale; contexts that never submitted (a Wayland relay's: its DRM
  file imports buffers, which makes a context, and never renders) are kept.
- **The next new GL use** makes a new renderer: virtio-gpu's next
  CTX_CREATE of an id that is not stale (the kernel makes a DRM file's
  context at its first 3D use, before its first resource), or the next
  vtest client. It is a new instance of the module (the factory again;
  `virgl.wasm` fetched again, normally from the HTTP cache) on a new
  OffscreenCanvas, 0.14 to 0.18 s on SwiftShader; commands queue
  meanwhile, the kept contexts are made again, the capsets are compared
  with those the guest's kernel cached (a size or version change fails it;
  other bytes are logged, as another GPU may lack features the guest
  uses). One try at a time; after a failure (no WebGL2 context: Chrome
  blocks a site from 3D after two GPU losses within 2 minutes, then
  `getContext()` gives null) the queued commands are answered as while
  lost and the next new GL program tries again a second later. A context
  that comes lost from its creation (the GPU process restarting) gets 5 s
  to be restored.
- **A restored context** (`webglcontextrestored`) is released at once
  (`loseContext()`): it is empty, and the module that used it is gone. The
  new renderer does not wait for it: Chrome restores a simulated loss only
  on `restoreContext()`, WebKit retries a real one every second, and a new
  context on a new canvas works in both while the page is not blocked.
- **After it**: commands naming a stale context or resource fail ("its
  context was in a WebGL2 context that was lost: restart the program",
  logged at most once a second) or are dropped (destroy, unref, detach,
  scanout, flush), so a stale program's ids leave no trace; new programs
  work as before.

What the user sees: programs running at the loss go on with every 3D
command failing until they exit, and must be restarted: glmark2-es2-drm ran
its scene to the end with a meaningless score, kmscube flipped its frames
to the end (paced by the vblank) with nothing shown, the guest's kernel
logged its rate-limited `response 0x1200` lines; X with glamor or a
compositor on the device: the same, restart it. A vtest client's socket
ends (glmark2-es2 under Xvfb: "lost connection to rendering server",
aborted). 2D is untouched: dumb buffers (fbcon, kms-dumb, X without glamor)
are the 2D model's, their pixels the guest's (a DRM file that opens one
makes a 3D context, which never submits: kept, or new; held without a
renderer if none was loaded). The page's display
shows no 3D frame until a live resource is scanned out (a stale KMS
client's scanout shows nothing; the 2D scanout returns when it exits).
Wayland: `image()` gives null for the stale clients' buffers, the relay
goes on, GL apps started after the loss show. Snapshots: stale resources
still block one until their programs end. The page's Guest GL row says
"WebGL context lost" (a warning: restart the GL programs; the next one
gets a new renderer, no reload) and afterwards counts the losses.

iOS (no device here; WebKit's source and bug reports, 2026-11-22): a
hidden or suspended page does not lose its contexts by itself (suspend
sets a flag); a GPU process that ends (crash, jetsam) loses every context
in it, restored by retries every second where the page prevented the
default (`didClose` -> `markContextLost`). Safari 16.7/17 betas lost
contexts on backgrounding (WebKit bugs 261331, 262628, fixed by 261313
around 17.1); on iOS 18 a page using about 2.7 GB lost its context, and
iOS may kill the whole page under memory pressure, reloading it, with no
event (bug 300782). No documented budget or guidance. `visibilitychange`
is not used: nothing of the renderer can be saved, so releasing the
context when hidden would itself end every GL program, and the new
renderer is made only on the guest's next GL use anyway. The iPhone
report of a second glmark2 run failing with SUBMIT_3D errors fits a loss
during or after the first run (every later command failed until a
reload); unconfirmed, and with this the next run gets a new renderer.

Checked 2026-11-22, `unkernel-check.mjs --drm --lose` (inline and
`--worker`, SwiftShader), four losses in one boot: during glmark2-es2-drm and restored, during
kmscube and a vtest glmark2-es2 and restored, during glmark2-es2-drm not
restored, during kmscube with `getContext()` giving no WebGL2 (the renewal
failed, the program at the loss and one after it ended); each time a
kmscube started after it rendered (frames on the canvas equal to the
scanout read back, 4096 colours, no failed command in the guest's kernel),
and after the first a dumb-buffer KMS client showed its picture and a vtest
client got virgl. `page-check.mjs --lose`: the row's warning, then the
ready row counting the loss after a new kmscube. `test/wland/page-check.mjs
--built --gpu` (worker): a weston-simple-egl window, the loss and restore,
then a new weston-simple-egl shown by resource with no renderer error
(the relay not restarted). `test/gl-gpu.test.ts` has the stale ids, the
kept contexts and two renewals against fake renderers.

## The page

Guest GL (Settings > Display and sound; on by default on Debian where the display
is, `?gl=0` off; web.md, Guest GL) boots with `gl: true` and `gpu: true`,
where the page's build has the renderer and the page's thread has WebGL2;
otherwise the option is disabled with the reason. `?gpu=0` (this load
only; also `?display=0`) leaves the device out: the vtest link alone, for
comparison; `?glload=eager` loads the renderer before the boot. The page builds with `virgl.mjs` and `virgl.wasm` from
`vendor/build/gl-wasm/` (with a local kernel), `KW_GL=<dir>`, or the
release's assets of those names (release.yml attaches them); the dev
server answers `/_gl/virgl.*`, a build emits both into
`/assets/virgl-<hash>/`; only the guest's first GL use fetches them. With GL on
the page adds `kw.gl=1` to the command line, for which the base's
`/etc/profile.d/kw-gl.sh` exports `GALLIUM_DRIVER=virpipe
LIBGL_ALWAYS_SOFTWARE=1` in the guest's shells only where there is no DRM
render node, so plain `eglinfo` or `glmark2-es2` uses virgl: through
`/dev/dri` with the device, through the vtest link without (with the
device, `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 cmd` takes the
vtest link for one program). KMS clients (kmscube, glmark2-es2-drm) show
on the page's display (Display.tsx, `vm.gl.gpu.drawFrame()`). The Guest GL row in System > Environment says
"on, not loaded yet" until the guest's first GL use, then names the
WebGL2 renderer (unmasked; a software one, SwiftShader, llvmpipe or WARP,
is a warning and a toast) and how long the load took and `vm.gl.stats` with the per-readback
breakdown of the renderer's counters (Stats) and the device's
(`vm.gl.stats.gpu`: presents, parks, time parked, readbacks, errors and
the last one's text; a lost WebGL2 context is a warning row, Context loss); `?glwait=strict` answers busy
waits as vtest does. The browser console has `[unkernel] guest GL: WebGL2
renderer ...`.

Checked 2026-11-21, `test/gl/page-check.mjs --suspend` (the dev server,
the default URL with `?data=0&cpus=1`, worker mode): GL on, `vm.gl.ready`
1.1 s after the page was opened with the renderer not loaded, the row
"on, not loaded yet" and no request for `virgl.*`; Suspend and a plain
load resumed it, still not loaded, the forwarder linked again; after
apt-get the first `eglinfo -B -p gbm` fetched both files (0.4 s after it
started) and got virgl, the load took 0.10 s; Suspend while kmscube ran
was refused with the page's message; a session suspended with `?gl=0`
resumed on the default URL with GL off. Before it, `--xorg` (then with
`?gl=1&data=0&cpus=1`, worker mode): `vm.gl.ready` 2.7 s after the page
was opened; a login shell had no GL variables, `/dev/dri/card0` (video,
0660) and `renderD128` (0666), and `/tmp/.virgl_test`; `apt-get install`
of Mesa, kmscube and X.Org over the page's network (deb.debian.org
through the CORS mirror) took 96 s; then `eglinfo -B -p gbm`: `virgl
(ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`, OpenGL ES 3.0
Mesa 25.0.7; kmscube (default user) at 55 to 58 fps, 121 presents in the
Guest GL row; X.Org 21.1.16's modesetting driver on `/dev/dri/card0`
("glamor X acceleration enabled on virgl (...)"), on it `glxinfo -B`
(virgl, OpenGL 2.1 compat, GLES 3.0, direct rendering) and glxgears at 60
FPS (page flips at the vblank rate, about 640 presents); X segfaults when
it is ended (SIGTERM; not examined). Before the device the same check
(now `--gpu0`) had the variables and `eglinfo -B -p surfaceless` on
virgl; not rerun since. The built server sends `/assets/virgl-*/virgl.{mjs,wasm}` with
JavaScript and wasm types, br-encoded, immutable (curl, not a browser).
Not checked: with `?gpu=0`, a GL client on the page's display (X.Org's
fbdev driver on kwfb, `sudo Xorg :0`, then `DISPLAY=:0 glmark2-es2`) and
its frame rate (kwfb is read about 50 times a second, at most about 1M
pixels); the device on several CPUs; packages
kept across reloads on the data disk. By hand on GPUs (2026-11-22): the
launcher's kmscube, glmark2 and X + glamor apps (web.md, Launcher) work
in Chrome, Safari and Firefox.

## Testing

```sh
gl/wasm/build.sh && gl/wasm/build.sh native
node gl/wasm/test/check.mjs                  # the module alone, a few s
test/gl/bridge-check.sh --wasm               # the suite on the wasm renderer, about 5 min
test/gl/bridge-check.sh --wasm --keep state  # one test, keep the logs and frames
test/gl/bridge-check.sh --wasm --strict-waits es2  # busy waits as vtest answers them
test/gl/bridge-check.sh --single             # the suite through the page to the native server
test/gl/vtest-check.sh --single              # the native server alone, about 2 min
test/gl/vtest-check.sh --fork                # a server process per client
test/gl/vtest-check.sh --server "$(command -v virgl_test_server)" info es2
test/gl/stream-check.sh state                # the stream link (unix socket) to the relay
test/gl/stream-check.sh --guest state        # the same through the guest's build under qemu-aarch64
node test/gl/debian-disk.mjs                 # the prepared disk, once (skipped when it exists)
node test/gl/unkernel-check.mjs              # unkernel in headless Chromium, about 4 min
node test/gl/unkernel-check.mjs --worker --skip c   # worker mode, without the benchmark
node test/gl/unkernel-check.mjs --drm        # the DRM path (gl and gpu; a bundle with kwvirtio), about 2 min
node test/gl/unkernel-check.mjs --drm --skip c,d --cmd 'modetest -c'   # a command of yours first (as root), its output printed
node test/gl/unkernel-check.mjs --drm --gl-flags ""   # the browser's own WebGL2 (a host with a GPU) instead of SwiftShader
node test/gl/unkernel-check.mjs --drm --eager --skip c   # the renderer loaded before the boot (gl.eager)
node test/gl/unkernel-check.mjs --drm --fail --glfail module   # the renderer fails at first use: what Mesa does, a dumb-buffer KMS client
node test/gl/unkernel-check.mjs --drm --fail --gl-flags "--disable-gpu --disable-software-rasterizer"   # no WebGL2 context: the 2D device
node test/gl/unkernel-check.mjs --drm --skip b,c,d,e --gl-delay 8   # virgl.mjs served 8 s late: the first GET_CAPS waits
node test/gl/unkernel-check.mjs --drm --snapshot --skip a,b,c,d,e,g   # step s: a snapshot with an idle 3D context, restored, the context used again
node test/gl/unkernel-check.mjs --drm --skip a,b,c,d,e,g,h   # step r: a display size change (--resize WxH): the hotplug, kmscube and glmark2-es2-drm at the new mode, the canvas (Display size)
node test/gl/unkernel-check.mjs --drm --lose --skip a,b,c,d,e,g,h,r   # step l: the WebGL2 context lost four ways, new programs after each (Context loss)
pnpm test:gl-gpu                             # VirglGpuBackend's snapshot blocker and contexts made again, GpuRenderer's context loss, no browser
node test/gl/page-check.mjs                  # the page's option (dev server, port 8091, the default URL), about 1 min; needs the internet
node test/gl/page-check.mjs --suspend        # plus suspend and resume before GL use, the refusal while kmscube runs, a session saved without GL
node test/gl/page-check.mjs --lose           # plus the WebGL2 context lost under kmscube: the row's warning, a new kmscube, the row after (Context loss)
node test/gl/page-check.mjs --gpu0           # the same with ?gpu=0 (the vtest link alone)
node test/gl/page-check.mjs --xorg           # plus X.Org's modesetting driver with glamor on the device (reported)
node test/gl/page-check.mjs --no-apt         # without Mesa: GL up, the guest's environment and the display resize (R)
node test/gl/page-check.mjs --no-apt --server http://127.0.0.1:8080   # against a dev server that runs (only read from); --inline for ?worker=0
```

`unkernel-check.mjs` builds what it needs and skips what exists: `pnpm
build` (the page imports `/dist/web.mjs`; `--no-build` skips it), the
prepared disk `vendor/build/gl/debian-gl.img` (`debian-disk.mjs`: boots
Debian on Node with the direct network, apt-installs the packages of
unkernel above as root, powers off cleanly; delete it after a new Debian
image, since its upper layer belongs to the image it was made on), and
`kwgl-state` for the guest (`build-guest-state.sh`). It serves the Debian
image and the disk read-only with Range requests (the guest's writes stay
in the page's memory), and the page boots with `gl: true` and runs: (a)
`eglinfo -B -p surfaceless` on virpipe (the renderer must be `virgl
(...)`); (b) `kwgl-state` interleaved against each client alone, as
`vtest-check.sh state` judges it, and with `--state-ref FILE` (the
`state.txt` that `bridge-check.sh --wasm --keep state` keeps) against the
host's own run, plus the same clients on llvmpipe (reported, not judged);
its frames are written as PPM; (c) glmark2-es2 under Xvfb, the same scenes
at the same size on virgl and on llvmpipe (`--size`, `--scenes`). The
steps' output, the page's log and the guest's console go to `--out`
(default a new `/tmp/kwgl.*`).

Tests: `info` (versions), `es2` and `gl` (glmark2, 16 scenes each; the
`.png` has a frame of each scene), `sdl` (neverball), `weston` (GL
compositor with a GL client), `multi` (six clients at once), `state`
(`kwgl-state.c`: seven surfaceless EGL clients, each with its own
deliberately different GL state set once, take turns frame by frame on the
server under test; each frame's checksum must equal that of the same client
run alone on a reference: the native multi-context server, or with `--wasm`
a second page with a fresh wasm renderer; it covers texture units and
samplers, uniform buffers, blend, colour mask, depth, stencil, cull, polygon
offset, scissor, viewport and depth range, vertex attribute enables, an
occlusion query open across turns, 3D mipmaps through the GL blitter, and
two contexts in one client). The screenshot tests only know that something
was drawn: look at the frames. With `--wasm` the page's log (the renderer's
stderr included) must have no unexpected line; `--glcheck` logs every
WebGL call that raises an error and `--glcount` the most frequent calls
(both fail that check by design). vtest-check's default server is
`vendor/build/gl-native`; it prints the one it uses. Unix socket paths must
stay under 108 bytes, so the scripts work in `/tmp/kwgl.*`.

Results (2026-11-21, the series of Patches):

| Run | Result |
| --- | --- |
| `bridge-check.sh --wasm` | all pass, logs clean |
| `bridge-check.sh --single` (relay) | all pass on the series before its last patch; not rerun since |
| `vtest-check.sh --single` | all pass, log clean |
| `vtest-check.sh` (multi-context, one process) | all pass, log clean |
| `vtest-check.sh --fork`, `--single --fork` | all pass; in some runs a client killed mid-command leaves a `VTEST_CLIENT_ERROR_COMMAND_DISPATCH` line |
| `stream-check.sh state`, `--guest state` | pass |
| `stream-check.sh info state` | state times out (its clients wait 120 s for replies the relay never brings), also at the commit before unkernel; `state` alone passes. Not examined |
| `unkernel-check.mjs` (inline; `--worker --skip c`) | all pass; Measured |
| `unkernel-check.mjs --drm` (inline; `--worker --skip c`) | all pass; The DRM path, Measured |
| `unkernel-check.mjs --drm --skip c`, lazy and `--eager`; `--fail` both ways; `--gl-delay 8` | all pass (2026-11-21); Loading on first use |
| `page-check.mjs`, `--suspend` | all pass; The page |
| `unkernel-check.mjs --drm --skip c` (inline; `--worker --skip c,d`) with window images (g), `--snapshot` (s) both modes | all pass (2026-11-22); The DRM path |
| `unkernel-check.mjs --drm --lose` (inline, `--worker`), `page-check.mjs --lose`, `test/wland/page-check.mjs --built --gpu`'s loss case | pass (2026-11-22); Context loss |
| `unkernel-check.mjs --drm --skip c` (inline) with multisampling (m, patch 17) | all pass (2026-11-22) |
| `unkernel-check.mjs --drm --skip a,b,c,d,e,g,h` (step r) and `page-check.mjs --no-apt` (R), inline and worker mode | all pass (2026-11-22); Display size |

Workloads that need no window system of ours (so nothing waits on wland):

| Workload | State |
| --- | --- |
| Xvfb with any X11 GL client (glmark2, SDL games, nested Weston) | works; what the scripts use. Xvfb needs no display device, so the same runs in the guest. |
| Surfaceless EGL through virgl | works with no display server at all (`kwgl-state.c` is one). |
| dEQP-GLES2/GLES3 and piglit | not packaged in Fedora; build from source. This is what Mesa's CI runs for virgl over vtest, with expectation lists in Mesa's tree (`src/gallium/drivers/virgl/ci/`). The best correctness suite now that the basics pass. |
| SDL's `offscreen` video driver | did not go through virgl as is: it picks an EGL device and Mesa then refuses the software driver. Unexplored further. |
| GL as compute (machine learning) | stops at GLES 3.0: no compute shaders, so no llama.cpp. A fragment-shader workload such as TensorFlow.js's WebGL backend is the only kind that could fit; unverified. |

## Open questions

- The DRM path on a GPU: not measured. Each presented frame is a blit and
  `transferToImageBitmap()` of the renderer's canvas, drawn into the
  page's 2D canvas; whether the page's compositor copies it again, and the
  fence rule's effect (`vm.gl.stats.gpu`: parks, parkedMs), are open.

- Readback cost per frame over kwvsock, and when to move it to kwshm: at
  640x480 the guest gets as many frames as a host client through the
  bridge (unkernel, Measured), so kwvsock is not the limit on SwiftShader;
  not measured with a GPU-backed WebGL2, where it may be.
- Frames on the page's display: whether X.Org's fbdev driver on kwfb
  presents virgl's frames as Xvfb does (the driver reads each frame back
  and puts it to X either way), and at what rate.
- Not tried in unkernel: the vtest path and the state checks on the SMP
  kernel (`cpus` > 1; vsock and so GL stay on the owner's thread, as on one
  CPU; the DRM path only as The DRM path says), and the vtest path in
  Firefox and Safari (the DRM path works there, The page).
- Busy waits on a GPU: not measured. On SwiftShader the rules of Busy
  waits remove the per-frame park (4.5 ms, about half of it WebGL's lag
  in telling a fence retired); on a GPU the page's Guest GL row shows the
  per-readback breakdown, and `?glwait=strict` vtest's answers for
  comparison.
- glFinish may return one wait before the GPU is done (Busy waits): a
  program that times the GPU with glFinish alone measures too little.
  Nothing else found relies on it.
- Draw-heavy scenes run at half the relay's rate in the browser; the
  remaining per-draw cost (state calls through emscripten, the base vertex
  emulation's attribute queries) is unmeasured in detail (`--glcount`).
