#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# The Alpine distro image: vendor/build/distro/alpine.erofs and alpine.ext4
# (guest/lib/image.sh), the read-only root that the base initramfs mounts
# under the root overlay: the aarch64 minirootfs as Alpine builds it, apk
# with lazy repositories and command-not-found installs, qemu-user for
# foreign binaries, the curl shim, the X.Org config. The kw guest
# tools, the runtime its init calls (/usr/lib/kw/) and the overlay root's
# boot logic come from the base. An `apk add` that was cut off needs no
# cleanup: run it again, and apk replaces what it left. The files unkernel
# adds are in rootfs/, at their installed paths (guest/lib/stage.sh:
# install_tree).
#
#   /sbin/init                busybox init (the minirootfs's), etc/inittab:
#                             the kw layer's rc, welcome and net (/usr/lib/kw/),
#                             the qemu-user binfmt formats, a shell on hvc0
#                             and kwtty serve (respawned); the layer's
#                             shutdown at poweroff
#   /usr/lib/kw-distro        "alpine"
#   /usr/lib/kw-image         alpine-<version>-<hash of the tree>
#   doas, doas-sudo-shim      `sudo` (pinned in pins.sh: ALPINE_APKS), which
#                             the image's own apk installs at build time in
#                             a boot of the tree on the base bundle
#                             (guest/tools/vm-run.ts; needs node): the
#                             real sudo is in community and 25 times their
#                             size (0.75 against 0.02 MB to download)
#   user                      the default user of the console and kwtty
#                             sessions (uid 1000, /bin/sh, /home/user with
#                             the README), in wheel, audio, video, input
#                             and users; doas without a password
#                             (/etc/doas.d/kw-user.conf, which sets ENV for
#                             `sudo -s`). Without doas (no bundle or node)
#                             the image has no user and every session is
#                             root's, as before
#
# OpenSSL's engines, legacy.so and *.dist stay (the image is not
# RAM-resident), and the image stays what apk installed (`apk audit`
# clean). Other packages come from apk on first use (the kw layer's shim
# installs libgcc for node, for instance).
# ALPINE_TARBALL=file overrides the pinned release (pins.sh).
set -euo pipefail

. "$(dirname "$0")/../../lib/env.sh"   # root, build, guest, dl, base_bundle, fetch_verified
. "$guest/lib/stage.sh"                # distro_unpack, install_tree, install_common
. "$guest/lib/image.sh"                # distro_images
. "$guest/distro/alpine/pins.sh"       # ALPINE_*
umask 022
here="$guest/distro/alpine"

distro_unpack alpine ALPINE   # $stage, $ALPINE_TARBALL
# apk starts with main only. Every apk command that loads the indexes parses
# all of them, and community (21k packages to main's 6k) makes that ~2.7 s
# instead of ~0.65 s under kwemu. Its line moves to /etc/kw-apk-lazy, and
# /etc/kw-apk-enable adds it back the first time something needs it
# (kw-apk-install, kw-qemu).
r="$stage/etc/apk/repositories"
grep '/community$' "$r" > "$stage/etc/kw-apk-lazy" || { echo "alpine: no community line in $r" >&2; exit 1; }
grep -v '/community$' "$r" > "$r.kw" && cat "$r.kw" > "$r" && rm "$r.kw"

install_tree "$here/rootfs" "$stage"
chmod 400 "$stage/etc/doas.d/kw-user.conf"
install_common "$stage"
echo 'hvc0' >> "$stage/etc/securetty"

# --- doas and sudo ---------------------------------------------------------------
# The image's apk installs the pinned packages (signed: it checks them
# with the image's keys) in a boot of the tree as it is (an uncompressed
# erofs image of it, on the base bundle), and what that changed in the
# root overlay's upper layer (ctime after a stamp: the files, the
# directories they are in, apk's database; deletions as whiteouts) comes
# out as a tar and goes into the tree. apk records a package added from a
# file as pinned to it in /etc/apk/world ("doas><Q1..."): the names stay,
# so that apk upgrade upgrades them. busybox's find has no -cnewer, hence
# stat. mktree.py then gives the new files root:root and the upstream
# epoch, so a rebuild is identical.
gen=alpine-apkgen
if [ ! -f "$base_bundle" ] || ! command -v node >/dev/null; then
	echo "alpine: WARNING: no $base_bundle (kernel/build.sh base) or no node: no doas, no sudo," \
		"so no user: every session is root's" >&2
else
	mkdir "$stage/kw-apks"
	while read -r f sum; do
		[ -n "$f" ] || continue
		fetch_verified "$ALPINE_APKS_URL/$f" "$dl/alpine-apks/$f" "$sum"
		cp "$dl/alpine-apks/$f" "$stage/kw-apks/"
	done <<< "$ALPINE_APKS"
	(KW_DISTRO_FORMATS=erofs KW_EROFS_COMPRESS=none KW_DISTRO_HINT=0 \
		distro_images "$gen" "$stage" "$ALPINE_TARBALL" "alpine-$ALPINE_VERSION") >/dev/null
	u=/run/kw-lower/kw/tmp/upper
	node "$guest/tools/vm-run.ts" "$base_bundle" "$distro_out/$gen.erofs" --timeout 300 \
		--get /tmp/kw-pkgs.tar="$distro_out/$gen.pkgs.tar" --get /tmp/kw-gone="$distro_out/$gen.gone" "
		set -e
		[ -d $u ]
		t=\$(date +%s)
		sleep 1
		apk add -q --no-network --no-cache /kw-apks/*.apk
		sed -i 's/><.*//' /etc/apk/world
		cd $u
		: > /tmp/kw-list
		: > /tmp/kw-gone
		find . -mindepth 1 ! -path './kw-apks*' | sort | while IFS= read -r p; do
			[ \$(stat -c %Z \"\$p\") -ge \$t ] || continue
			if [ -c \"\$p\" ]; then echo \"\$p\" >> /tmp/kw-gone; else echo \"\$p\" >> /tmp/kw-list; fi
		done
		tar -cf /tmp/kw-pkgs.tar --no-recursion --numeric-owner -T /tmp/kw-list" ||
		{ echo "alpine: installing doas in the image failed" >&2; exit 1; }
	rm -rf "$stage/kw-apks"
	while read -r p; do rm -rf "${stage:?}/${p#./}"; done < "$distro_out/$gen.gone"
	tar -xpf "$distro_out/$gen.pkgs.tar" -C "$stage" --no-same-owner
	rm -f "$distro_out/$gen".{erofs,tar,id,pkgs.tar,gone}
fi

# --- the user ----------------------------------------------------------------------
if [ -x "$stage/usr/bin/doas" ] && [ -x "$stage/usr/bin/sudo" ]; then
	install_user "$stage" /bin/sh wheel audio video input users
	install_readme "$stage" alpine NAME="Alpine Linux" USERLAND="musl, busybox" PKG="apk add" \
		MIRROR="Alpine's" AUTO=KW_AUTO_APK DISTRO=alpine REPO=https://github.com/pithings/unkernel
fi

distro_images alpine "$stage" "$ALPINE_TARBALL" "alpine-$ALPINE_VERSION" "${user_owner[@]}"
