#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Fetches a real-world shader corpus (Sascha Willems' Vulkan examples, GLSL
# and their shipped SPIR-V; vkmark; GTK 4's GSK shaders) into
# $KW_BUILD/vk/corpus and compiles the GLSL for Vulkan 1.0 and 1.3, plain
# and spirv-opt -O (GTK: as its meson.build does); SDL 3's GPU shaders
# (DXC-compiled SPIR-V embedded in headers) as shipped. Then:
#   node vk/naga/test/corpus.ts $KW_BUILD/vk/corpus/spv
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
dir="${KW_BUILD:-$root/vendor/build}/vk/corpus"
mkdir -p "$dir"
cd "$dir"
if [ ! -d sascha ]; then
	git clone -q --depth 1 --filter=blob:none --sparse https://github.com/SaschaWillems/Vulkan.git sascha
	git -C sascha sparse-checkout set shaders/glsl
fi
[ -d vkmark ] || git clone -q --depth 1 https://github.com/vkmark/vkmark.git vkmark
if [ ! -d sdl ]; then
	git clone -q --depth 1 --filter=blob:none --sparse https://github.com/libsdl-org/SDL.git sdl
	git -C sdl sparse-checkout set test src/render/gpu/shaders
fi
if [ ! -d gtk418 ]; then
	# The GTK in the guest (Debian trixie): 4.18.
	git clone -q --depth 1 --branch 4.18.6 --filter=blob:none --sparse https://gitlab.gnome.org/GNOME/gtk.git gtk418 2>/dev/null
	git -C gtk418 sparse-checkout set gsk/gpu/shaders
fi
if [ ! -d gtk ]; then
	git clone -q --depth 1 --filter=blob:none --sparse https://gitlab.gnome.org/GNOME/gtk.git gtk
	git -C gtk sparse-checkout set gsk/gpu/shaders
fi
rm -rf spv
mkdir -p spv/shipped
find sascha/shaders/glsl -name '*.spv' | grep -E '\.(vert|frag|comp)\.spv$' | while read -r f; do
	cp "$f" "spv/shipped/$(echo "${f#sascha/shaders/glsl/}" | tr / _)"
done
for env in vulkan1.0 vulkan1.3; do
	mkdir -p "spv/$env" "spv/$env-opt"
	find sascha/shaders/glsl vkmark/data/shaders -type f \( -name '*.vert' -o -name '*.frag' -o -name '*.comp' \) | while read -r f; do
		name="$(echo "$f" | tr / _)"
		glslangValidator -V --target-env "$env" -I"$(dirname "$f")" -o "spv/$env/$name.spv" "$f" >/dev/null 2>&1 || { rm -f "spv/$env/$name.spv"; continue; }
		spirv-opt -O "spv/$env/$name.spv" -o "spv/$env-opt/$name.spv" 2>/dev/null || rm -f "spv/$env-opt/$name.spv"
	done
done
mkdir -p spv/sdl
find sdl -name '*.spv.h' | while read -r h; do
	python3 -I -c 'import re, sys; t = open(sys.argv[1]).read(); open(sys.argv[2], "wb").write(bytes(int(x, 16) for x in re.findall(r"0x([0-9a-fA-F]{2})", t[t.index("{"):])))' "$h" "spv/sdl/$(basename "$h" .h)"
done
# GTK: generated instance headers, then vertex, fragment and clip-mask
# fragment variants (glslc -std=450 with includes, here via a wrapper).
mkdir -p spv/gtk gtkgen gtkwrap
shaders=gtk/gsk/gpu/shaders
for s in "$shaders"/gskgpu*.glsl; do
	b="$(basename "$s" .glsl)"
	python3 -I "$shaders/generate-glsl-interface.py" --generate-glsl "$s" >"gtkgen/${b}instance.glsl"
	for v in vert:GSK_VERTEX_SHADER frag:GSK_FRAGMENT_SHADER clip.frag:GSK_FRAGMENT_SHADER; do
		st="${v%%:*}"
		printf '#version 450\n#extension GL_GOOGLE_include_directive : require\n#include "%s.glsl"\n' "$b" >"gtkwrap/$b.$st"
		extra=()
		[ "$st" = clip.frag ] && extra=(-DGSK_VULKAN_HAS_CLIP_MASK)
		glslangValidator -V --target-env vulkan1.0 -S "${st##*.}" -D"${v##*:}"=1 "${extra[@]}" -I"$shaders" -Igtkgen \
			-o "spv/gtk/$b.$st.spv" "gtkwrap/$b.$st" >/dev/null || rm -f "spv/gtk/$b.$st.spv"
	done
done
mkdir -p spv/gtk418 gtk418wrap
for s in gtk418/gsk/gpu/shaders/gskgpu*.glsl; do
	b="$(basename "$s" .glsl)"
	for v in vert:GSK_VERTEX_SHADER frag:GSK_FRAGMENT_SHADER; do
		st="${v%%:*}"
		printf '#version 450\n#extension GL_GOOGLE_include_directive : require\n#include "%s.glsl"\n' "$b" >"gtk418wrap/$b.$st"
		glslangValidator -V --target-env vulkan1.0 -S "$st" -D"${v##*:}"=1 -Igtk418/gsk/gpu/shaders \
			-o "spv/gtk418/$b.$st.spv" "gtk418wrap/$b.$st" >/dev/null || rm -f "spv/gtk418/$b.$st.spv"
	done
done
# llama.cpp's ggml-vulkan compute shaders (a subset of vulkan-shaders-gen's variants).
if [ ! -d llamacpp ]; then
	git clone -q --depth 1 --filter=blob:none --sparse https://github.com/ggml-org/llama.cpp.git llamacpp
	git -C llamacpp sparse-checkout set ggml/src/ggml-vulkan
fi
python3 -I "$root/vk/naga/test/llama-shaders.py" llamacpp/ggml/src/ggml-vulkan/vulkan-shaders spv/llama >/dev/null
rm -rf spv/llama/src
for d in spv/*; do echo "$d: $(ls "$d" | wc -l)"; done
