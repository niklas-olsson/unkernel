# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Sourced after kernel/tools/env.sh (root, vendor, build, fetch_verified).
# vk_headers DIR: the pinned Vulkan headers (vk/pins.sh) into DIR/vulkan and
# DIR/vk_video, downloaded once into vendor/downloads ($KW_VK_DOWNLOADS
# overrides the directory) and checked against their SHA-256 sum.
. "$root/vk/pins.sh"
vk_headers() {
	local dir="$1" dl="${KW_VK_DOWNLOADS:-$vendor/downloads}"
	local tgz="$dl/vulkan-headers-$VULKAN_HEADERS_VERSION.tar.gz"
	fetch_verified "$VULKAN_HEADERS_URL" "$tgz" "$VULKAN_HEADERS_SHA256"
	mkdir -p "$dir"
	tar -xzf "$tgz" -C "$dir" --strip-components=2 \
		"Vulkan-Headers-$VULKAN_HEADERS_VERSION/include/vulkan" "Vulkan-Headers-$VULKAN_HEADERS_VERSION/include/vk_video"
}
