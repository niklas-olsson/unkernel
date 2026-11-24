// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The C API of the wasm virglrenderer module (gl/wasm/build.sh): the page
// hands the module a WebGL2 context, opens a client per vtest connection,
// feeds each client's bytes as they arrive and sends back the reply bytes.
// Nothing here blocks: input may arrive in any chunks (a command runs once
// all its bytes are in), and a waiting busy wait is answered at once where
// that cannot make the guest read invalid data (kw_virgl.c, busy_wait: right
// after a readback, or at most one wait ahead of the GPU) and otherwise parks
// the client until the fences it waits for (every client's) have retired;
// kw_virgl_poll, called from a later task, answers it then (a WebGL fence
// only signals between tasks).
// Single-threaded: call everything from the thread that owns the context.
#ifndef KW_VIRGL_H
#define KW_VIRGL_H

#include <stdint.h>

// kw_virgl_feed and kw_virgl_poll results for a client
#define KW_VIRGL_OK 0      // every complete command ran; a partial one waits for more bytes
#define KW_VIRGL_PARKED 1  // a waiting VCMD_RESOURCE_BUSY_WAIT is pending: kw_virgl_poll later

// Initialise the renderer on the WebGL2 context with this emscripten handle
// (GL.registerContext; the JS helper virgl.init(gl) does both). 0, or a
// negative errno. One renderer, one context, for the life of the module.
int kw_virgl_init(int webgl_context);

// kw_virgl_open flags: the dialect (kw_virgl.c). 0: plain vtest over a byte
// pipe, where the client falls back to protocol version 0 (transfer data in
// the stream; one client at a time). KW_VIRGL_INLINE: protocol version 3
// with no fds, transfer data inline (TRANSFER_PUT2 followed by its data,
// TRANSFER_GET2 answered with it), as gl/bridge/vtest-bridge.c speaks it.
#define KW_VIRGL_INLINE 1
// Another flag: every waiting busy wait of the client parks until the fences
// submitted before it have retired (vtest's own answer, slower), in place of
// the answers ahead of the GPU that busy_wait in kw_virgl.c gives.
#define KW_VIRGL_STRICT_WAIT 2

// Open a client (one vtest connection): its id (> 0), or a negative errno.
int kw_virgl_open(uint32_t flags);

// Close a client: destroys its renderer context and resources and drops
// its unread reply bytes.
void kw_virgl_close(int client);

// Queue LEN bytes of the client's vtest stream and run every command that is
// now complete. KW_VIRGL_OK, KW_VIRGL_PARKED, or a negative errno: the
// stream is broken (a protocol error or a failed command, where the native
// server would drop the connection); close the client.
int kw_virgl_feed(int client, const uint8_t *data, uint32_t len);

// Retire finished fences and resume parked clients. Returns how many clients
// are still parked (call again from a later task while it is not 0: WebGL
// sync objects only change between tasks).
int kw_virgl_poll(void);

// The client's reply bytes: a pointer into the module's memory and their
// count, valid until the next call into the module; kw_virgl_consume drops
// the first N of them once sent.
const uint8_t *kw_virgl_reply_ptr(int client);
uint32_t kw_virgl_reply_len(int client);
void kw_virgl_consume(int client, uint32_t n);

// The client's state: KW_VIRGL_OK, KW_VIRGL_PARKED, or a negative errno
// (-ENOENT: no such client).
int kw_virgl_state(int client);

// Counters over all clients since init, for the page: KW_VIRGL_STAT_COUNT
// doubles, indexed by these (times in ms of emscripten_get_now, the time
// each command took, the GL calls it made included; WebGL runs most GL
// calls asynchronously, but reads that return data wait for the GPU).
enum {
	KW_VIRGL_STAT_SUBMITS,      // VCMD_SUBMIT_CMD: decoding and issuing GL
	KW_VIRGL_STAT_SUBMIT_MS,
	KW_VIRGL_STAT_READS,        // TRANSFER_GET(2): glReadPixels or getBufferSubData
	KW_VIRGL_STAT_READ_MS,
	KW_VIRGL_STAT_WRITES,       // TRANSFER_PUT(2): uploads
	KW_VIRGL_STAT_WRITE_MS,
	KW_VIRGL_STAT_OTHERS,       // every other command
	KW_VIRGL_STAT_OTHER_MS,
	KW_VIRGL_STAT_WAITS,        // waiting VCMD_RESOURCE_BUSY_WAITs, which are answered:
	KW_VIRGL_STAT_WAITS_READ,   //   at once, right after a readback of the same resource
	KW_VIRGL_STAT_WAITS_DONE,   //   at once, their fences retired already
	KW_VIRGL_STAT_WAITS_AHEAD,  //   at once, ahead of their fences
	KW_VIRGL_STAT_PARKS,        //   after parking
	KW_VIRGL_STAT_PARKED_MS,    // from parking to the answer, all parks
	KW_VIRGL_STAT_PARK_MAX_MS,  // the longest park
	KW_VIRGL_STAT_POLLS,        // kw_virgl_poll calls that found a parked client
	KW_VIRGL_STAT_COUNT
};
const double *kw_virgl_stats(void);

// virtio-gpu (kw_virgl.c has the contract): the guest's virtio_gpu DRM
// driver on the same renderer, next to the vtest clients, after
// kw_virgl_init. Its commands count in the stats above (SUBMIT_3D as a
// submit, TRANSFER_FROM_HOST_3D as a read, TRANSFER_TO_HOST_3D as a write).

// Run one control command (a copy, header first) with the transfer's
// packed DATA: 0, or the virtio-gpu response type of the error.
int kw_vgpu_command(const uint8_t *cmd, uint32_t len, uint8_t *data, uint32_t data_len);
// The capsets the device offers before the renderer is up (the SDK's
// VIRGL_CAPSETS, js/core/gl-gpu.ts, has the same numbers and checks the
// module's capsets against them): VIRTGPU_DRM_CAPSET_VIRGL (1) and VIRGL2
// (2), each with virglrenderer's max version and size (struct
// virgl_caps_v1, v2; kw_virgl.c checks the sizes at compile time).
#define KW_VGPU_CAPSET_VIRGL_VERSION 1
#define KW_VGPU_CAPSET_VIRGL_SIZE 308
#define KW_VGPU_CAPSET_VIRGL2_VERSION 2
#define KW_VGPU_CAPSET_VIRGL2_SIZE 1408
// A capset as the guest gets it: its size (0: none) or a negative errno.
int kw_vgpu_capset(uint32_t id, uint8_t *out, uint32_t cap, uint32_t *max_version);
// A virgl format's blocks: width | height << 8 | bytes << 16, or 0.
uint32_t kw_vgpu_format(uint32_t format);
// Another implicit fence after all GL work so far (its number), and the
// last one retired.
uint32_t kw_vgpu_fence(void);
uint32_t kw_vgpu_fences_done(void);
// The host GL errors of guests' commands so far: each one a call the host
// dropped (WebGL refuses calls that GLES leaves undefined), logged, with the
// context going on. Only GL_OUT_OF_MEMORY puts a context in error.
uint32_t kw_vgpu_gl_errors(void);
// A resource's texture, width, height, virgl format, Y_0_TOP and whether
// the format has alpha (OUT has 6 words); 0 or -ENOENT.
int kw_vgpu_info(uint32_t res, uint32_t *out);
// Blit a rectangle of a resource (row 0 at the top) to the context's
// drawing buffer, sized w x h by the caller, top row at the top; colour and
// alpha as the texture has them, unless these flags say otherwise.
#define KW_VGPU_BLIT_OPAQUE 1u // alpha 1 (an X format, the scanout)
#define KW_VGPU_BLIT_FLIP_Y 2u // the picture's top row at the bottom
int kw_vgpu_blit(uint32_t res, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t flags);
// kw_vgpu_blit() with KW_VGPU_BLIT_OPAQUE: the scanout.
int kw_vgpu_present(uint32_t res, uint32_t x, uint32_t y, uint32_t w, uint32_t h);
// Read a rectangle back (rows from the top, w * bpp bytes each).
int kw_vgpu_read(uint32_t res, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t bpp, uint8_t *out);

#endif
