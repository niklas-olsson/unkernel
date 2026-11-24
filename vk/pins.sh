# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of guest Vulkan (vk/build.sh), sourced. The Vulkan headers
# the ICD and its test programs build against: Khronos' release tag, the
# version of Debian trixie's loader (libvulkan1 1.4.309), so the build needs
# no headers on the host.
VULKAN_HEADERS_VERSION=1.4.309
VULKAN_HEADERS_URL="https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v$VULKAN_HEADERS_VERSION.tar.gz"
VULKAN_HEADERS_SHA256=437925ada160d86ed763d29dcb9318c1bb0d024d7deaf77bc7c170b8eb6b6f10
