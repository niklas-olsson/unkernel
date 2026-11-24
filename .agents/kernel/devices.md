# Devices

The kernel side of each host device. Host sides are in js.md, SMP paths
in smp.md (Devices), imports and IRQ numbers in kernel.md.

Display, input, sound, vsock, shm and kwvirtio are lazy: each `_init`
import returns < 0 (kwvirtio: <= 0) when the host has no such device, and
then nothing is registered.
Display, input and sound allocate nothing until a program opens the
device, and the host is told on open and close. None of these imports
suspends. A new device adds only its own imports (diff the module's
imports against a build without it). The CLI offers vsock by default and
display, sound, shm and virtio-gpu on request (`--display`, `--sound`,
`--shm`, `--gpu`); the page offers all but shm and virtio-gpu.

Sizes (lowered kernel): display +37 KiB, input +49 KiB, sound +142 KiB
(30 KiB of it OSS), vsock +45 KiB (+15.7 KB gzip), kwshm +6 KiB (+1.8 KB
gzip) (2026-11-14); 9p +141 KiB (+52 KB gzip, 28 KiB of RAM; 2026-11-15);
kwvirtio with DRM and virtio-gpu +660 KB (+217 KB gzip; config.md).

## Console (hvc_wasm)

`drivers/tty/hvc/hvc_wasm.c`, `console=hvc0`, on WASI fd 1 (output) and fd
0 (input, read only after a zero-timeout `poll_oneoff`, so it never
blocks). The size comes from `wasm_driver_console_size()` (`rows << 16 |
cols`, 0 = unknown): set on the tty when it is opened and re-read on each
input poll; the host raises IRQ 1 after a resize, and programs get
SIGWINCH. The images set `TERM=xterm-256color` for the console shell
(`/etc/profile.d/kw-term.sh`), replacing busybox init's `vt102`.

## kwblk (block)

`drivers/block/kwblk.c`: blk-mq, one hw queue (depth 32), disks `wda`,
`wdb`, ... probed at boot (`wasm_driver_block_info`); up to 15 partitions,
no hot-plug or resize, no FUA (the block layer emulates it with flushes).
`->queue_rq()` writes the request (op, sector, direct-mapped segment
addresses) into its PDU and calls `wasm_driver_block_submit`, which never
suspends, so it is fine in blk-mq's atomic dispatch context (no
`BLK_MQ_F_BLOCKING`, no kthread). The host completes it synchronously
(return <= 0 = status) or returns 1, later writes the status into the PDU
and raises IRQ 3; the handler drains `wasm_driver_block_reap()`. Read,
write, flush (volatile write cache), discard and write-zeroes (if the
backend has them).

**Sync (IRQ 4)**: the handler queues a work item that runs `ksys_sync()`
(writeback of every file system, journal commits, device flushes);
requests made before it runs coalesce. Host: `Kernel.requestSync()` (js.md).

## kwnet (network)

`drivers/net/kwnet.c`: an Ethernet device whose frames are copied to and
from the host (`wasm_driver_net_init`/`send`/`rx_len`/`recv`; `net_init`
< 0 means no device). Received frames raise IRQ 2 and are drained by NAPI
into GRO. It claims checksum offload and TSO and marks RX
`CHECKSUM_UNNECESSARY`, so the guest computes no checksums and sends 64 KiB
TCP segments. The host stack (10.0.2.15/24, gateway 10.0.2.2, DNS
10.0.2.3) and its limits are in js.md, Network.

## kwfb (display)

`drivers/video/fbdev/kwfb.c`: `/dev/fb0`, 32 bpp XRGB8888, write and mmap.

- `wasm_driver_fb_init()`; `wasm_driver_fb_mode()` (`width << 16 |
  height`, 0 = 640x480), asked at the first open; `wasm_driver_fb_attach(
  pixels, width, height, stride, format)` at the first open and on every
  mode change, NULL at the last close. It returns the picture's size in mm
  (`width << 16 | height`, 0 = unknown), which becomes
  `fb_var_screeninfo` `width` and `height` (X.Org's fbdev driver ignores
  them and assumes 96 dpi; Qt's linuxfb uses them). The page counts 96 CSS
  pixels to the inch; the CLI takes `--display=WxH@DPI`.
- The host reads the pixels in place whenever the kernel yields (at most
  about 50 times a second while a program is busy); there is no vsync.
- The buffer is one contiguous allocation and the buddy allocator gives at
  most 4 MiB, so each side is clamped to 64..4096 and a mode above 1M
  pixels is divided by the smallest integer that fits (1920x1032 becomes
  960x516); if the allocation still fails, the size is halved.
  `FBIOPUT_VSCREENINFO` changes the size only while the caller's file is
  the only one open and nothing is mapped (EBUSY otherwise);
  `line_length` is always 4 * xres.
- One program has the display at a time: a user open fails with EBUSY
  while another user open file exists (kernel opens, `user == 0`, are not
  refused; there is no fbcon). The claim is the file's, so it lasts
  through fork and through a mapping that outlives `close()`, and ends at
  the file's release, which exit always reaches.
- mmap inserts the pages directly: `vm_insert_page` rejects large kmalloc
  pages here.

## kwinput (input)

`drivers/input/kwinput.c`, present only with the display: event0 "kwinput
keyboard" (keys 1..255, no autorepeat), event1 "kwinput mouse" (REL_X,
REL_Y, REL_WHEEL, three buttons) and event2 "kwinput tablet", an absolute
pointer like QEMU's usb-tablet (ABS_X/ABS_Y 0..32767 over the whole
picture, REL_WHEEL, three buttons; no BTN_TOUCH, tool bits or
INPUT_PROP_DIRECT, so udev and libinput call it a mouse with absolute
motion and X's evdev an absolute pointer). Device numbers 0, 1, 2 in the
events and the open mask.

- `wasm_driver_input_init()`; `wasm_driver_input_state(mask)` from the open
  and close callbacks; `wasm_driver_input_read(buf, max)` pulls 12-byte
  events (device, type, code, value) after the host raises IRQ 5. The host
  delivers events only while a program has the device open.
- kw_defconfig switches HID (which `INPUT` turns on) and the hardware input
  drivers off.
- **Only user space may open these devices**: the host routes keys to evdev
  instead of the console while the keyboard is open, so an in-kernel
  handler that opens what it matches breaks the console. sysrq's handler is
  a passive observer (the `wasm: sysrq` patch, `passive_observer`: it sees
  events while evdev has the device open, so Alt-SysRq works then, but
  never calls `open`). A lower `MAGIC_SYSRQ_DEFAULT_ENABLE` would not do:
  writing a non-zero `kernel.sysrq` registers the handler again, and
  systemd sets 16. Any new handler (VT kbd, leds, mousedev, joydev) needs
  the same care; kwtest's `input handlers` check fails on handlers other
  than evdev and sysrq, and `test/api.test.ts` asserts that nothing is open
  before glimmer opens the devices.

## kwsnd (sound)

`sound/drivers/kwsnd.c`: ALSA card 0, `hw:0,0`, playback only, U8 and
S16_LE, mono or stereo, 8000-48000 Hz, plus OSS `/dev/dsp` (SND_PCM_OSS);
no mixer, no capture, no PCM timer, no `/proc/asound`.

- `wasm_driver_sound_init()` (the host's preferred rate, or 0);
  `wasm_driver_sound_event(event, rate, channels, format)` (0 close, 1
  open, 2 prepare, 3 start, 4 stop); `wasm_driver_sound_write(buf, bytes)`,
  which the host copies during the call and answers with the frames it has
  queued.
- A kernel timer on the host's monotonic clock hands over the frames the
  elapsed time is worth every 2-10 ms (the period, 2 ms or more, in a
  buffer of 10 ms or more); no IRQ bit. A late tick hands over at most
  three ticks' worth (15 ms' worth when ticks are shorter than 5 ms), and
  an underrun stops the stream, so nothing spins.

## kwvsock (AF_VSOCK)

`net/vmw_vsock/kwvsock.c`, host `js/core/vsock.ts`: an AF_VSOCK transport
on `virtio_transport_common`, registered as the G2H transport the way
`vsock_loopback` registers its local one (KWVSOCK selects
VIRTIO_VSOCKETS_COMMON and needs no VIRTIO; `virtio_transport_stream_allow`
lives in virtio_transport.c, so kwvsock has its own).

- Guest CID 3 (`KWVSOCK_GUEST_CID`), host CID 2; streams only (no
  seqpacket, no datagrams), with virtio-vsock's credit flow control.
  Packets are virtio-vsock's (`struct virtio_vsock_hdr`, then the payload);
  the host runs the other end of the protocol. Without the device
  `connect()` fails with ENODEV.
- Sends keep their order: a packet the host refuses (-EAGAIN) goes back to
  the head of the queue and is retried after IRQ 6 (the SDK refuses only
  through its `refuse` test hook, since credit bounds the data).
- RX takes packets into linear skbs of at most `rx_max` (32 KiB less the
  shared info; the host keeps every packet within it) and calls
  `virtio_transport_recv_pkt(..., NULL)` (global mode, like virtio-vsock);
  a failed skb allocation leaves the packet with the host and retries 10 ms
  later.
- After a snapshot restore it resets connections (parking.md).
- kw_defconfig: VSOCKETS, VSOCKETS_DIAG (`ss --vsock`), KWVSOCK, not
  VSOCKETS_LOOPBACK.
- Guest tools (guest.md): `kwvsock`, `kwtty` (terminal sessions, programs
  on pipes and TCP relays for the host, port 1022), `kw9p`, the guest
  GL forwarder `kwbox vtest` (connects to host port 1019;
  gl.md), and wland's relay `/usr/lib/kw/wlandr` (the Debian image's; connects to host port
  1023, the page's `WAYLAND_PORT`; its buffers are kwshm exports, below;
  web.md, Wayland desktop).

## kwshm (shared memory)

`drivers/misc/kwshm.c`, UAPI `include/uapi/linux/kwshm.h`, host
`js/core/shm.ts`: the host reads and writes the pages of guest shmem files
(memfds, `/dev/shm` files) in place. The host opens or creates files in
`/dev/shm` by name; guest programs export a shmem fd through `/dev/kwshm`
(ioctl `KWSHM_IOC_EXPORT`, magic 0xBB, listed in ioctl-number.rst) and send
the id to the host over any channel.

- An export is a file or a page-aligned range of one, with an id (IDR,
  cyclic from 1, shared by host and guest exports; at most 4096, and at
  most half of RAM pinned). Its folios are pinned with `memfd_pin_folios()`
  (FOLL_PIN with FOLL_LONGTERM semantics, udmabuf's interface), which also
  allocates holes, so every page the host sees is the file's. A pin rather
  than a reference: it is the documented way to give something outside the
  kernel's mappings long-lived access, lets compaction skip the folio
  early (`folio_maybe_dma_pinned()`), and moves pages out of
  ZONE_MOVABLE/CMA first (none here). `F_SEAL_WRITE` uses the same
  refcount test, so it fails with EBUSY while exported.
- A truncation or hole punch removes pinned folios from the page cache
  (`folio->mapping` becomes NULL) but cannot free them, so the host never
  touches freed or reused memory; its view may go stale: another size
  (`i_size` against the export's; range exports are clamped to their
  range) or a held folio whose mapping or index no longer matches. There is
  no change notification; the host learns staleness with a check, a round
  trip. Unpinning marks a writable export's folios dirty
  (`folio_mark_dirty_lock()`).
- Host writes bypass kwemu: code the host writes into a page a guest
  program executes is not seen until an IC IVAU or a flush.
- Ordering: every export is announced (attach) when it is made, refreshed
  and released, so a guest export's page list is at the host before the
  guest sends its id, and an attach comes before the reply to the request
  that caused it. A refresh unpins the old pages only after the new list's
  attach, a release only after the detach returned. A host that reads the
  pages from another thread (worker mode on the SMP kernel's shared
  memory, js.md, shm) keeps this by waiting inside those imports for its
  reader to let go.
- Host opens look the name up in PID 1's fs (`scoped_with_init_fs()`: a
  kworker's own root is nullfs) without following a final symlink.
- Closing `/dev/kwshm` releases its exports; an export is writable for the
  host only if the fd is writable and not sealed against writes. One mutex
  covers everything. At power-off the kernel releases nothing; the host
  forgets every export.
- kw_defconfig: KWSHM (depends on SHMEM and MEMFD_CREATE).

## kwvirtio (virtio transport) and virtio-gpu (`/dev/dri`)

`drivers/virtio/kwvirtio.c`, host `js/core/virtio.ts`: a virtio transport
whose registers are host imports, so that stock virtio drivers run
unmodified against device models in the SDK. Only virtio-gpu
(`drivers/gpu/drm/virtio`, host `js/core/virtio-gpu.ts`) is enabled.

- Imports (`wasm_driver_virtio_*`): `init(index)` (the device ID of the
  host's device `index`, <= 0: none; devices are 0, 1, ... without holes,
  at most 8), `features`, `set_features` (after `vring_transport_features`;
  VIRTIO_F_VERSION_1 is required), `config(dev, offset, buf, len, write)`,
  `status` (0 resets; the kernel keeps the status byte itself),
  `queue_max`, `queue_set(dev, queue, num, desc, avail, used)` (num 0
  takes it down), `notify(dev, queue)`, `interrupt(dev)` (reads and clears
  the interrupt status: bit 0 used buffers, bit 1 config change). None
  suspends; `notify` comes in atomic context.
- Split rings from `vring_create_virtqueue()`, no indirect descriptors, no
  event index, no ACCESS_PLATFORM. Without ACCESS_PLATFORM `virtio_ring`
  and virtio-gpu do not use the DMA API for the rings and commands
  (`vring_use_map_api()` and `virtio_gpu_use_dma_api()` are false), so every
  address is physical, i.e. a kernel memory offset, and the host reads
  and writes rings and buffers in place.
- One IRQ for all devices: `WASM_IRQ_VIRTIO` (10), `IRQF_SHARED`; each
  device's handler runs `virtio_config_changed()` and `vring_interrupt()`
  on its queues.
- Each device's parent is a platform device `kwvirtio.N` with a 32-bit DMA
  mask. virtio-gpu makes the parent its DRM device, and
  `drm_gem_shmem_get_pages_sgt()` maps a buffer's sg table with
  `dma_map_sgtable()` on it, which dma-direct does one to one; virtio-gpu
  passes `orig_nents` page addresses to the host anyway. libdrm (Debian
  13's 2.4.124) takes the parent as it is: `drmGetDevice2()` reads
  `device/subsystem` (platform) and, with no OF node, the `MODALIAS`
  (`platform:kwvirtio`) for the device's name, and Mesa's loader, finding
  no PCI ids, names the driver from DRM_IOCTL_VERSION (`virtio_gpu`), as
  it logs: "device is not located on the PCI bus", "using driver
  virtio_gpu". Nothing in the kernel was needed for that (2026-11-21).
- SMP: the process-context calls go through `kw_host_call()`; a notify on
  another CPU sets the queue's bit in the device's pending mask and raises
  `WASM_IRQ_VIRTIO` on CPU 0, whose handler sends it before it reads the
  interrupt status.

virtio-gpu: `/dev/dri/card0` and `renderD128`, driver name `virtio_gpu`,
one CRTC and connector, KMS with dumb buffers (GEM shmem objects in the
guest, their pages handed to the host as the resource's backing), and 3D
when the host offers VIRTIO_GPU_F_VIRGL (`createKernel({ gl, gpu })` in a
browser: two capsets, VIRGL and VIRGL2, from the renderer's WebGL2
context; gl.md, The DRM path). Without it Mesa falls back to software.
There is no udev: the kw layer's rc gives `card*` to video (0660) and
`renderD*` to everyone (0666), as udev's rules do (guest.md).

- Display size: the connector's one mode is the host's EDID mode (the
  host's display size, preferred). A size change on the host is the
  config space's VIRTIO_GPU_EVENT_DISPLAY with a config interrupt
  (kwvirtio's KWVIRTIO_INT_CONFIG, `virtio_config_changed()`); the stock
  driver's work item asks for the EDID and display info again and calls
  `drm_kms_helper_hotplug_event()`: a `change` uevent of `card0` with
  HOTPLUG=1 on the kernel's netlink group, and nothing else (no fbdev
  client). The modes are refreshed when a DRM master probes the connector
  (GETCONNECTOR with no modes; `/sys/class/drm/card0-Virtual-1/status`
  "detect"). With no udev a program hears of it only from netlink itself
  (`test/gpu/kms-hotplug.c`); libudev monitors (X's modesetting driver)
  listen to udevd's group and hear nothing. Nothing in the kernel was
  needed (js.md, virtio-gpu).

- What the kernel side does not use: `vmap()` (VMALLOC_FLAT cannot map
  scattered pages). The 2D paths pass backing as page lists and never
  vmap; only `drm_gem_shmem_vmap()` callers would (fbdev emulation, the
  panic screen, dma-buf importers that vmap), and DRM_FBDEV_EMULATION and
  DRM_PANIC are off. PRIME between openers of the device (a client's
  dmabuf imported by a compositor) is a self-import, which maps nothing
  (`test/gpu/prime.c`; gl.md, The DRM path). virtio-gpu has no vblank
  interrupt from the host: it emulates one with DRM's vblank timer
  (`DRM_CRTC_VBLANK_TIMER_FUNCS`, at the mode's refresh, 60 Hz from the
  EDID), so a page-flipping client runs at most at 60 frames a second
  (kmscube: 59.97, 2026-11-21), and so do DIRTYFB updates. The timer runs
  on for `drm.vblankoffdelay` after its last use (100 ms: the kw layer's rc lowers
  the kernel's 5 s, kernel/guest.md) (`test/gpu/flip-check.mjs`
  counts the host's idles), then an idle guest has no periodic timer.
  No kthreads (its work items run on the system workqueue), so parking
  needs nothing new.
- A DIRTYFB transfers its rectangle only: the series backports
  a9cc9905ddb7 ("drm/virtio: Recalculate ignore_damage_clips on every
  update", 7.4), without which the flag sticks after the first commit that
  changes the framebuffer, and 730f8554f35c, which keeps a rendered
  resource's damage clips across page flips.
- DRM_IOCTL_VIRTGPU_GET_CAPS waits up to 30 s for a capset the kernel has
  not cached, killably (patch 0048, "drm/virtio: wait up to 30 s for a
  capset"; upstream 5 s, then -EBUSY): the host loads its 3D renderer on
  the first capset request, which may fetch it over the network (gl.md,
  Loading on first use).
- Snapshots: the host refuses one ("virtio-gpu resources", or
  "virtio-gpu contexts" with 3D: at once, before the guest parks; -EBUSY at
  the snapshot point for unanswered commands) while the device holds
  resources, contexts or unanswered commands, which a KMS client
  that has exited no longer does; otherwise it saves the transport state
  (status, features, each queue's addresses and next available index) and
  a restore picks it up, with nothing in the kernel (no restore notifier).
- kw_defconfig: VIRTIO_MENU, KWVIRTIO, DRM, DRM_VIRTIO_GPU,
  DRM_VIRTIO_GPU_KMS; not VIRTIO_MMIO, VIRTIO_BALLOON, VIRTIO_INPUT,
  DRM_FBDEV_EMULATION, DRM_PANIC, DRM_DDC, DRM_HDMI_INFOFRAMES,
  DRM_PANEL_BRIDGE, NET_DEVMEM.
- Check: `node test/gpu/check.mjs` (a dumb-buffer client,
  `test/gpu/kms-dumb.c`, against the host's frame, and display size
  changes heard by `test/gpu/kms-hotplug.c`; testing.md).

## 9p (host file systems)

Host file systems use the stock 9p client with the fd transport: no driver
and no host import (host `js/core/9p.ts`, guest `guest/src/kw9p.c`).
`kwbox 9p NAME DIR [ro]` connects an AF_VSOCK socket to the host (CID 2, port
564) and mounts 9P2000.L with `trans=fd,rfdno=S,wfdno=S`,
`cache=readahead` and `metatimeout=1000`; the client takes its own
references to the socket, so kw9p exits after mount(2) and unmounting
closes the connection. `mount` and `df` show `kw9p:NAME`. What the guest
caches and the numbers: js.md, Host file systems.

The patch `9p: add metatimeout` adds `metatimeout=MS`, because stock fs/9p
has no attribute timeout and no way for the server to invalidate a guest
cache: CACHE_META with an expiry per inode (`v9fs_inode.attr_expire`, set
in `v9fs_stat2inode_dotl`), checked in `__v9fs_lookup_revalidate` and
`v9fs_vfs_getattr_dotl`; `v9fs_refresh_inode_dotl` then drops the pages of
a file whose qid.version, size or mtime changed and leaves a name that now
holds another qid.path invalid. Negative dentries get the same expiry. It
is meant for 9P2000.L (with the legacy protocols lookups always
revalidate, but a stat of a cached inode is not refreshed); without the
option nothing changes. `v9fs_get_tree` refuses it with EINVAL in any cache
mode with CACHE_WRITEBACK (mmap, loose, fscache, or a bitmask with that
bit): the CACHE_META getattr path skips the flush of dirty pages and a
refresh rewrites the inode from the server, which could truncate pending
writes.

kw_defconfig: NETWORK_FILESYSTEMS (the menu that holds 9P_FS; nothing else
in it is on), NET_9P (selects NETFS_SUPPORT), NET_9P_FD, 9P_FS; not
9P_FS_POSIX_ACL, 9P_FSCACHE or the virtio, Xen, RDMA and USB transports.
kwtest checks that the type is registered.
