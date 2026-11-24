#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Combined image samplers passed to a function, textureLod, textureSize.
layout(set = 0, binding = 0) uniform sampler2D a;
layout(set = 0, binding = 1) uniform sampler2D b;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
vec4 tap(sampler2D s, vec2 p) {
	return texture(s, p) + textureLod(s, p, 0.0);
}
void main() {
	o = tap(a, uv) * tap(b, uv * 2.0) + vec4(textureSize(a, 0), 0.0, 0.0);
}
