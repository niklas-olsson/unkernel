#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// GTK 4 GSK style: array varyings, a combined image sampler array used
// with constant indices in a spec-constant if chain (glslang leaves an
// OpUndef after it), and a sampler array element passed to a function.
#define Rect vec4[1]
layout(constant_id = 1) const uint SAMPLE_OP = 0;
layout(set = 0, binding = 0) uniform sampler2D TEX[3];
layout(location = 0) in vec2 _pos;
layout(location = 1) flat in Rect _bounds;
layout(location = 2) flat in vec4 _color;
layout(location = 3) flat in vec4 _corners[2];
layout(location = 0) out vec4 out_color;
vec4 straight(sampler2D t, vec2 p) {
	vec4 c = texture(t, p);
	return vec4(c.rgb * c.a, c.a);
}
vec4 tex0(vec2 p) {
	if (SAMPLE_OP == 0u)
		return texture(TEX[0], p);
	else if (SAMPLE_OP == 1u)
		return straight(TEX[0], p);
	else if (SAMPLE_OP == 2u)
		return vec4(texture(TEX[0], p).x, texture(TEX[1], p).xy, 1.0);
}
void main() {
	out_color = tex0(_pos) * _color + _bounds[0] + _corners[1];
}
