// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Appended to the emscripten module (--post-js): JS helpers over the C API
// (kw_virgl.h), as Module.virgl:
//
//   const Module = await createVirgl({ print, printErr });
//   const v = Module.virgl;
//   v.init(gl);                  // a WebGL2RenderingContext (canvas or OffscreenCanvas)
//   const c = v.open(v.INLINE);  // one per vtest connection; 0: the plain dialect;
//                                // | v.STRICT_WAIT: vtest's busy waits (kw_virgl.h)
//   v.feed(c, bytes);            // a Uint8Array chunk of the client's stream
//   const out = v.take(c);       // its reply bytes so far (a copy), maybe empty
//   v.poll();                    // from a later task while a client is parked
//   v.close(c);
//
// feed and poll return what kw_virgl_feed and kw_virgl_poll do.
//
// v.Renderer is the same in the renderer shape of gl/bridge (relay.js):
//   const r = new v.Renderer(gl);      // { inline: true, strictWaits: false } by default
//   r.onreply = (id, bytes) => ...;    r.onclose = (id, why) => ...;
//   await r.init(); r.open(id); r.feed(id, bytes); r.close(id);
// with the page's own client ids; it polls parked clients by itself.
// r.stats(id): { parks, parkedMs }, how often and how long the client's
// busy waits were parked. r.totals(): the counters of all clients since
// init (v.stats(), kw_virgl.h, KW_VIRGL_STAT_*), and how many later tasks
// polled parked clients, through a message or a timeout (messagePolls,
// timerPolls).
//
// v.gpu is the virtio-gpu entry (kw_vgpu_*): command(), capset(), format(),
// fence(), fencesDone(), glErrors(), info(), blit(), present(), read(); see below.

Module['virgl'] = (() => {
  let scratch = 0, scratchSize = 0, initGL = null;
  // KW_VIRGL_STAT_*, in order
  const STATS = ['submits', 'submitMs', 'reads', 'readMs', 'writes', 'writeMs', 'others', 'otherMs',
    'waits', 'waitsRead', 'waitsDone', 'waitsAhead', 'parks', 'parkedMs', 'parkMaxMs', 'polls'];
  const check = (r, what) => {
    if (r < 0) throw new Error(`${what}: error ${-r}`);
    return r;
  };
  const v = {
    OK: 0,
    PARKED: 1,
    INLINE: 1,
    STRICT_WAIT: 2,
    // Register GL (a WebGL2 context) with emscripten and start the renderer;
    // again with the same context: nothing.
    init(gl, attributes = {}) {
      if (initGL) {
        if (gl !== initGL) throw new Error('virgl: already initialised on another context');
        return 0;
      }
      const handle = GL.registerContext(gl, {
        majorVersion: 2, minorVersion: 0, enableExtensionsByDefault: true, ...attributes,
      });
      if (!handle) throw new Error('GL.registerContext failed');
      check(_kw_virgl_init(handle), 'kw_virgl_init');
      initGL = gl;
      return 0;
    },
    open: (flags = 0) => check(_kw_virgl_open(flags), 'kw_virgl_open'),
    close: (client) => _kw_virgl_close(client),
    feed(client, bytes) {
      if (bytes.length > scratchSize) {
        if (scratch) _free(scratch);
        scratchSize = Math.max(bytes.length, 65536);
        scratch = _malloc(scratchSize);
        if (!scratch) { scratchSize = 0; throw new Error('out of memory'); }
      }
      HEAPU8.set(bytes, scratch);
      return _kw_virgl_feed(client, scratch, bytes.length);
    },
    take(client) {
      const n = _kw_virgl_reply_len(client);
      if (!n) return new Uint8Array(0);
      const p = _kw_virgl_reply_ptr(client);
      const out = HEAPU8.slice(p, p + n);
      _kw_virgl_consume(client, n);
      return out;
    },
    poll: () => _kw_virgl_poll(),
    state: (client) => _kw_virgl_state(client),
    // The module's counters (kw_virgl_stats), named as in STATS.
    stats() {
      const a = new Float64Array(HEAPU8.buffer, _kw_virgl_stats(), STATS.length);
      return Object.fromEntries(STATS.map((k, i) => [k, a[i]]));
    },
    // virtio-gpu on the same renderer (kw_virgl.h, kw_vgpu_*; the SDK's
    // gl-gpu.ts drives it), after init().
    gpu: {
      // A heap buffer of n bytes for a transfer's packed data, valid until
      // the next call into the module: command() then copies nothing.
      buffer(n) {
        heapReserve(n);
        return HEAPU8.subarray(gbuf, gbuf + n);
      },
      // Run a control command (Uint8Array, header first) with the
      // transfer's packed data (a Uint8Array; for TRANSFER_FROM_HOST_3D
      // filled on return): 0, or the virtio-gpu response type of the error.
      command(cmd, data) {
        const n = data ? data.length : 0;
        const inHeap = n && data.buffer === HEAPU8.buffer && data.byteOffset === gbuf;
        if (!inHeap) heapReserve(n);
        const c = _malloc(cmd.length);
        if (!c) return 0x1201; // ERR_OUT_OF_MEMORY
        HEAPU8.set(cmd, c);
        if (n && !inHeap) HEAPU8.set(data, gbuf);
        const r = _kw_vgpu_command(c, cmd.length, gbuf, n);
        _free(c);
        if (n && !inHeap) data.set(HEAPU8.subarray(gbuf, gbuf + n));
        return r;
      },
      // A capset as the guest gets it: { version, data } or null.
      capset(id) {
        heapReserve(65536);
        const ver = _malloc(4);
        const size = _kw_vgpu_capset(id, gbuf, 65536, ver);
        const version = HEAPU32[ver >> 2];
        _free(ver);
        return size > 0 ? { version, data: HEAPU8.slice(gbuf, gbuf + size) } : null;
      },
      format: (f) => _kw_vgpu_format(f) >>> 0,
      fence: () => _kw_vgpu_fence() >>> 0,
      fencesDone: () => _kw_vgpu_fences_done() >>> 0,
      glErrors: () => _kw_vgpu_gl_errors() >>> 0,
      // A resource's GL texture (the WebGLTexture of the renderer's context,
      // null for a buffer), size, virgl format, whether row 0 is the top and
      // whether the format has alpha; null for no such resource.
      info(res) {
        const p = _malloc(24);
        const r = _kw_vgpu_info(res, p);
        const a = HEAPU32.slice(p >> 2, (p >> 2) + 6);
        _free(p);
        if (r < 0) return null;
        return { texture: a[0] ? GL.textures[a[0]] ?? null : null, width: a[1], height: a[2], format: a[3], yTop: a[4] === 1, alpha: a[5] === 1 };
      },
      // Blit (x, y, w, h) of a resource to the context's drawing buffer, which the
      // caller sized w x h, top row at the top; flags BLIT_OPAQUE (alpha 1),
      // BLIT_FLIP_Y (top row at the bottom). 0 or a negative errno.
      BLIT_OPAQUE: 1,
      BLIT_FLIP_Y: 2,
      blit: (res, x, y, w, h, flags = 0) => _kw_vgpu_blit(res, x, y, w, h, flags),
      // blit() with BLIT_OPAQUE: the scanout.
      present: (res, x, y, w, h) => _kw_vgpu_present(res, x, y, w, h),
      // Read (x, y, w, h) back, rows from the top: a Uint8Array, or null.
      read(res, x, y, w, h, bpp = 4) {
        const n = w * h * bpp;
        heapReserve(n);
        return _kw_vgpu_read(res, x, y, w, h, bpp, gbuf) < 0 ? null : HEAPU8.slice(gbuf, gbuf + n);
      },
    },
  };
  let gbuf = 0, gbufSize = 0;
  function heapReserve(n) {
    if (n <= gbufSize) return;
    if (gbuf) _free(gbuf);
    gbufSize = Math.max(n, 1 << 20);
    gbuf = _malloc(gbufSize);
    if (!gbuf) { gbufSize = 0; throw new Error('out of memory'); }
  }

  v.Renderer = class {
    name = 'virgl-wasm';
    onreply = () => {};
    onclose = () => {};
    #gl;
    #flags;
    #clients = new Map(); // page id -> module client
    #stats = new Map(); // page id -> { parks, parkedMs, since }
    #polling = false;
    #rounds = 0;
    #wake = null;
    #messagePolls = 0;
    #timerPolls = 0;

    constructor(gl, { inline = true, strictWaits = false } = {}) {
      this.#gl = gl;
      this.#flags = (inline ? v.INLINE : 0) | (strictWaits ? v.STRICT_WAIT : 0);
    }

    async init() {
      v.init(this.#gl);
      return `virglrenderer (wasm) on ${this.#gl.getParameter(this.#gl.VERSION)}`;
    }

    open(id) {
      this.#clients.set(id, v.open(this.#flags));
      this.#stats.set(id, { parks: 0, parkedMs: 0, since: 0 });
    }

    stats(id) {
      const s = this.#stats.get(id);
      return s && { parks: s.parks, parkedMs: s.parkedMs };
    }

    totals() {
      return { ...v.stats(), messagePolls: this.#messagePolls, timerPolls: this.#timerPolls };
    }

    feed(id, bytes) {
      const c = this.#clients.get(id);
      if (c === undefined) return;
      this.#after(id, c, v.feed(c, bytes));
    }

    close(id) {
      const c = this.#clients.get(id);
      if (c === undefined) return;
      this.#clients.delete(id);
      this.#stats.delete(id);
      v.close(c);
    }

    #after(id, c, r) {
      const out = v.take(c);
      if (out.length) this.onreply(id, out);
      const s = this.#stats.get(id);
      if (r === v.PARKED && !s.since) s.parks++, (s.since = performance.now());
      else if (r !== v.PARKED && s.since) (s.parkedMs += performance.now() - s.since), (s.since = 0);
      if (r < 0) {
        this.#clients.delete(id);
        v.close(c);
        this.onclose(id, `renderer error ${-r}`);
      } else if (r === v.PARKED && !this.#polling) {
        this.#polling = true;
        this.#rounds = 0;
        this.#later();
      }
    }

    // The next poll, from a later task. A fence usually signals within a
    // few tasks: the first rounds go through a message, which is not
    // clamped as nested timeouts are (to 4 ms), later ones through a
    // timeout, so that a long wait does not keep the thread busy.
    #later() {
      if (this.#rounds++ < 16) {
        if (!this.#wake) {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => this.#poll();
          this.#wake = ch.port2;
        }
        this.#messagePolls++;
        this.#wake.postMessage(0);
      } else {
        this.#timerPolls++;
        setTimeout(() => this.#poll(), 1);
      }
    }

    // Parked clients: poll from later tasks (WebGL fences signal between
    // tasks) until none is left.
    #poll() {
      const parked = v.poll();
      for (const [id, c] of this.#clients) this.#after(id, c, v.state(c));
      this.#polling = parked > 0;
      if (this.#polling) this.#later();
    }
  };
  return v;
})();
