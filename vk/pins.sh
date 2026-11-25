# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of guest Vulkan (vk/build.sh), sourced. The Vulkan headers
# the ICD and its test programs build against: Khronos' release tag, the
# version of Debian trixie's loader (libvulkan1 1.4.309), so the build needs
# no headers on the host.
VULKAN_HEADERS_VERSION=1.4.309
VULKAN_HEADERS_URL="https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v$VULKAN_HEADERS_VERSION.tar.gz"
VULKAN_HEADERS_SHA256=437925ada160d86ed763d29dcb9318c1bb0d024d7deaf77bc7c170b8eb6b6f10
# glslc, a host tool for test/vk/guest/build-llama.sh (ggml-vulkan's
# shaders), built by vk/glslc.sh: shaderc's release tag and the glslang,
# SPIRV-Tools and SPIRV-Headers commits of its DEPS file (glslang 16.6.0,
# SPIRV-Tools v2026.4). The SPIR-V headers also serve ggml-vulkan's
# find_package(SPIRV-Headers).
SHADERC_VERSION=2026.4
SHADERC_URL="https://github.com/google/shaderc/archive/refs/tags/v$SHADERC_VERSION.tar.gz"
SHADERC_SHA256=f06ce5bcca94e5df7f34e115743597d0ad2e13c5fe9213c67dc8c76031241947
GLSLANG_COMMIT=e1b562a8bed273a02f30b59b66a5d499793cede5
GLSLANG_URL="https://github.com/KhronosGroup/glslang/archive/$GLSLANG_COMMIT.tar.gz"
GLSLANG_SHA256=907174a24713c6202c146f164bf81783f1fbc79c8cb821a30f18f159eb980312
SPIRV_TOOLS_COMMIT=ef96ed763b43b59b33b31b362f09a02b729fa1c9
SPIRV_TOOLS_URL="https://github.com/KhronosGroup/SPIRV-Tools/archive/$SPIRV_TOOLS_COMMIT.tar.gz"
SPIRV_TOOLS_SHA256=82c62146083fd558735a3171cf97cfc47903ca7d368482e87f94bd44883c0f00
SPIRV_HEADERS_COMMIT=04fd3caa1e8267e4d95c806cad901181728e1006
SPIRV_HEADERS_URL="https://github.com/KhronosGroup/SPIRV-Headers/archive/$SPIRV_HEADERS_COMMIT.tar.gz"
SPIRV_HEADERS_SHA256=392f4801409aad9c4f1b77745f179952fd6264e4c8bd0fc1bc45dfa6807bf6d0
