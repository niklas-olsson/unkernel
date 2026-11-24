#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# The base initramfs, base.cpio: what the distroless bundle
# (vendor/build/bundle/unkernel.wasm, `kernel/build.sh base`, which runs
# this through guest/build.sh) boots. It finds the distro, a read-only
# image (erofs or ext4) labelled kwroot that the host attaches as a block
# device, and makes the root an overlay of it with the changes on the data
# disk (/data/distros/NAME) or in memory; with no distro it starts the base
# shell. The files are real files in initramfs/ and rootfs/, at their
# installed paths (guest/lib/stage.sh: install_tree); initramfs/init has
# the boot sequence and the state on /data.
#
#   /init, /bin/busybox     initramfs/init; Alpine's static busybox
#                           (busybox-static, pinned in pins.sh) and its applets
#   /kw/lib/sysinit          sysinit of the base shell (etc/inittab)
#   /kw/layer/              rootfs/: the top lower layer of the root, so
#                           every distro has it (RAM-resident: keep it
#                           small): usr/bin/kwbox (guest/src/kwbox.c: the
#                           guest tools kwtty, kw9p, kwvsock, kwshm, kwwasi,
#                           kwcmd (guest/src/) and vtest-bridge
#                           (gl/bridge/vtest-bridge.c, stream link only, the
#                           guest GL forwarder that the SDK's `gl` option
#                           starts) as one program), usr/sbin/kw-overlay,
#                           usr/lib/kw/ (rc, welcome, net, udhcpc, shutdown,
#                           data-stop: the runtime a distro's init calls; shrc: the kw-*.sh profile files for
#                           interactive shells that are not login shells;
#                           kwwasi: binfmt_misc's interpreter, a link to kwbox;
#                           shim and bin/: fx, claude, opencode, node,
#                           npm, npx, bun, bunx, uv, uvx on first use;
#                           bin/wland: Wayland apps in the page, through
#                           the relay the Debian image carries;
#                           libvulkan_kw.so: guest Vulkan's ICD, vk/icd,
#                           with usr/share/vulkan/icd.d/kw_icd.json),
#                           etc/profile.d/{kw-path.sh,kw-term.sh,kw-gl.sh,kw-wayland.sh},
#                           etc/chromium.d/kw-wayland,
#                           usr/local/bin/Xwayland (the distro's, with a
#                           pointer on its root window), the X.Org
#                           fbdev/evdev config, usr/share/licenses/unkernel,
#                           usr/lib/kw-base (the base's id), and an empty
#                           /data mount point. Its scripts run the base's
#                           busybox (#!/run/kw-lower/bin/busybox sh)
#   /etc, /usr              the base shell's inittab, profile and passwd,
#                           and links into /kw/layer
#
# The kernel tests and benchmark (guest/src/test/) come as a second
# archive (rdinit=/usr/bin/kwtest, abitest, kwbench): base-test.cpio always
# has them, base.cpio too unless KW_RELEASE=1. Outputs go to
# vendor/build/initramfs, or to $KW_BASE_OUT (guest/lib/env.sh).
set -euo pipefail

. "$(dirname "$0")/../lib/env.sh"     # root, zig, dl, base_out, cc_guest, fetch_verified, need_zig
. "$guest/lib/stage.sh"               # install_tree
. "$guest/base/pins.sh"               # BUSYBOX_STATIC_*
need_zig
umask 022
out="$base_out"
src="$guest/base"
mkdir -p "$out" "$dl"

fetch_verified "$BUSYBOX_STATIC_URL" "$dl/$BUSYBOX_STATIC_APK" "$BUSYBOX_STATIC_SHA256"
stage="$out/base-root"
rm -rf "$stage" "$out/base-apk"
mkdir -p "$stage/bin" "$out/base-apk"
# An apk is gzipped tar segments (signature, control, data); tar reads them
# as one archive and warns about apk's own pax headers.
tar -xzf "$dl/$BUSYBOX_STATIC_APK" -C "$out/base-apk" bin/busybox.static 2>/dev/null
install -m 755 "$out/base-apk/bin/busybox.static" "$stage/bin/busybox"
rm -rf "$out/base-apk"
# Every applet as a relative link in /bin, so /run/kw-lower/bin works after
# the switch whatever the distro has in /bin. The names come from busybox's
# applet name table (sorted, NUL-separated, starting "[", "[["), so the
# build needs no aarch64 runner.
python3 -I - "$stage/bin/busybox" > "$out/base-applets" <<'EOF'
import re, sys
b = open(sys.argv[1], "rb").read()
i = b.find(b"\0[\0[[\0")
if i < 0 or b.find(b"\0[\0[[\0", i + 1) >= 0:
    sys.exit("busybox: no unique applet name table")
names, j = [], i + 1
while True:
    k = b.index(b"\0", j)
    n = b[j:k].decode("ascii", "replace")
    if not re.fullmatch(r"[][a-z0-9_.-]+", n):
        break
    names.append(n)
    j = k + 1
if names != sorted(names):
    sys.exit("busybox: the applet names are not sorted")
print("\n".join(names))
EOF
for a in sh mount umount pivot_root chroot dd tr init sed awk mountpoint udhcpc ip du sysctl hostname kill sleep head printf uname poweroff reboot halt; do
	grep -qx "$a" "$out/base-applets" || { echo "base: busybox has no $a applet" >&2; exit 1; }
done
while read -r a; do ln -s busybox "$stage/bin/$a"; done < "$out/base-applets"
rm "$out/base-applets"

# Mount points and the directories /init uses.
mkdir -p "$stage"/{dev,proc,sys,run,tmp,data,mnt,root,etc,kw/distro,kw/tmp,kw/lib,usr/bin,usr/sbin,usr/lib}
chmod 1777 "$stage/tmp"
install_tree "$src/initramfs" "$stage"
printf '%s\n' 'root:x:0:0:root:/root:/bin/sh' > "$stage/etc/passwd"
printf '%s\n' 'root:x:0:' 'tty:x:5:' > "$stage/etc/group"
echo hvc0 > "$stage/etc/securetty"

# The kw layer. Its directories are the merged root's where the distro has
# the same ones (the top lower layer wins), so they are all 755.
layer="$stage/kw/layer"
mkdir -p "$layer"/{data,etc/profile.d,usr/bin,usr/sbin,usr/lib/kw}
# The guest tools as one program, usr/bin/kwbox (guest/src/kwbox.c: one
# libc for all; `kwbox TOOL ARGS`), each tool's source an object with its
# main renamed. vtest-bridge is the guest GL forwarder (.agents/gl.md):
# vtest clients to the host's renderer over kwvsock. binfmt_misc cannot
# pass a TOOL, so kwwasi has a link of its own (relative: the layer is at
# / in a distro's root).
tools=(kwvsock kwshm kwtty kw9p kwwasi kwcmd)
obj="$out/kwbox-obj"
objs=()
rm -rf "$obj"
mkdir -p "$obj"
for t in "${tools[@]}"; do
	"${cc_guest[@]}" -c "-Dmain=${t}_main" -o "$obj/$t.o" "$guest/src/$t.c"
	objs+=("$obj/$t.o")
done
"${cc_guest[@]}" -c -DVTEST_BRIDGE_STREAM_ONLY -Dmain=vtest_bridge_main -o "$obj/vtest-bridge.o" "$root/gl/bridge/vtest-bridge.c"
"${cc_guest[@]}" -o "$layer/usr/bin/kwbox" "$guest/src/kwbox.c" "${objs[@]}" "$obj/vtest-bridge.o"
rm -rf "$obj"
ln -s /kw/layer/usr/bin/kwbox "$stage/usr/bin/kwbox"   # for the base shell
ln -s ../../bin/kwbox "$layer/usr/lib/kw/kwwasi"
install_tree "$src/rootfs" "$layer"
# Guest Vulkan's ICD (vk/icd/build.sh, .agents/vk.md): the Vulkan loader's
# driver for the SDK's `vk` option, in the layer for the reason vtest-bridge
# is (its link protocol belongs to the SDK). Its manifest is in the
# loader's default search path, so a distro's loader (Debian: libvulkan1)
# finds it with no environment variables. Needs the Vulkan headers on this
# host; KW_VK=0 leaves it out.
if [ "${KW_VK:-1}" != 0 ]; then
	"$root/vk/icd/build.sh" guest >/dev/null
	install -m 755 "$build/vk/libvulkan_kw.so" "$layer/usr/lib/kw/libvulkan_kw.so"
	mkdir -p "$layer/usr/share/vulkan/icd.d"
	install -m 644 "$build/vk/kw_icd.json" "$layer/usr/share/vulkan/icd.d/kw_icd.json"
fi
ln -s /kw/layer/usr/sbin/kw-overlay "$stage/usr/sbin/kw-overlay"
ln -s /kw/layer/usr/lib/kw "$stage/usr/lib/kw"
find "$stage" -type d -exec chmod go+rx {} +
chmod 700 "$stage/root"

# The base's id (a hash of the tree: names, modes, links, contents).
id=$(tar -C "$stage" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | sha256sum | cut -c1-16)
echo "base-$id" > "$layer/usr/lib/kw-base"
echo "base id: base-$id"

# The kernel tests and benchmark, as a second archive (see the top).
tstage="$out/base-test-root"
rm -rf "$tstage"
mkdir -p "$tstage/usr/bin"
for t in kwtest kwbench; do
	"${cc_guest[@]}" -o "$tstage/usr/bin/$t" "$guest/src/test/$t.c"
done
"$zig" cc -target aarch64-linux-none -mcpu=generic -nostdlib -ffreestanding -static -O2 \
	-fno-stack-protector -s "-ffile-prefix-map=$root/=" -o "$tstage/usr/bin/abitest" "$guest/src/test/abitest.c"

nodes=(--node dev/console:c:5:1:600 --node dev/null:c:1:3:666)
python3 "$guest/tools/mkcpio.py" "$stage" "$out/base-image.cpio" "${nodes[@]}"
python3 "$guest/tools/mkcpio.py" "$tstage" "$out/base-tests.cpio"
cat "$out/base-image.cpio" "$out/base-tests.cpio" > "$out/base-test.cpio"
rm "$out/base-tests.cpio"
if [ "${KW_RELEASE:-0}" = 1 ]; then
	mv "$out/base-image.cpio" "$out/base.cpio"
else
	rm "$out/base-image.cpio"
	cp "$out/base-test.cpio" "$out/base.cpio"
fi
echo "initramfs: $out/base.cpio ($(du -k --apparent-size "$out/base.cpio" | cut -f1) KiB, $(gzip -9c "$out/base.cpio" | wc -c | awk '{ printf "%d", $1 / 1024 }') KiB gzipped)"
