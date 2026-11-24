#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Texture kinds: separate texture + sampler, cube, 3D, 2D array, integer
// textures with texelFetch, an SSBO with atomics, and gl_FragCoord.
layout(set = 0, binding = 0) uniform texture2D sepTex;
layout(set = 0, binding = 1) uniform sampler sepSampler;
layout(set = 0, binding = 2) uniform samplerCube cube;
layout(set = 0, binding = 3) uniform sampler3D vol;
layout(set = 0, binding = 4) uniform sampler2DArray layers;
layout(set = 0, binding = 5) uniform usampler2D ids;
layout(set = 0, binding = 6) uniform isampler2D signedTex;
layout(set = 1, binding = 0) buffer Counter { uint hits; vec4 last; } counter;
layout(location = 0) in vec3 dir;
layout(location = 0) out vec4 o;
void main() {
	vec4 c = texture(sampler2D(sepTex, sepSampler), dir.xy);
	c += texture(cube, dir) + texture(vol, dir) + texture(layers, vec3(dir.xy, 1.0));
	uint id = texelFetch(ids, ivec2(gl_FragCoord.xy), 0).r;
	int s = texelFetch(signedTex, ivec2(0), 0).r;
	atomicAdd(counter.hits, id);
	counter.last = c;
	o = c * float(id) + float(s);
}
