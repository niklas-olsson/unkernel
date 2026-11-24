#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Descriptor arrays: combined image samplers, separate textures and
// samplers, uniform buffers; constant and dynamic indices.
layout(set = 0, binding = 0) uniform sampler2D tex[3];
layout(set = 0, binding = 1) uniform texture2D images[2];
layout(set = 0, binding = 2) uniform sampler samplers[2];
layout(set = 1, binding = 0) uniform UBO { vec4 color; int pick; } ubos[2];
layout(location = 0) in vec2 uv;
layout(location = 1) flat in int idx;
layout(location = 0) out vec4 o;
void main() {
	vec4 c = texture(tex[1], uv);
	c += texture(tex[idx], uv);
	c += texture(sampler2D(images[0], samplers[1]), uv);
	c += texelFetch(sampler2D(images[idx], samplers[0]), ivec2(0), 0);
	c += vec4(textureSize(tex[idx], 0), 0.0, 0.0);
	c *= ubos[1].color + ubos[idx].color;
	o = c;
}
