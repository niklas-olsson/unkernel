#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// GTK 4 GSK style: array varyings (#define Rect vec4[1]), a switch whose
// cases end in if/else returns, a spec-constant if chain.
#define Rect vec4[1]
layout(constant_id = 0) const uint FLAGS = 0;
layout(location = 0) in vec4 in_bounds;
layout(location = 1) in vec4 in_color;
layout(location = 0) out vec2 _pos;
layout(location = 1) flat out Rect _bounds;
layout(location = 2) flat out vec4 _color;
layout(location = 3) flat out vec4 _corners[2];
vec4 pick(uint i) {
	switch (i) {
	case 0u:
		if (in_bounds.x > 0.0) return in_color; else return in_color.bgra;
	case 1u:
	case 2u:
		return vec4(1.0);
	default:
		return vec4(0.0);
	}
}
void main() {
	Rect b = Rect(in_bounds);
	_pos = in_bounds.xy;
	_bounds = b;
	_corners[0] = in_bounds;
	_corners[1] = in_color;
	if (FLAGS == 1u)
		_color = pick(uint(gl_VertexIndex) / 3u);
	else
		_color = in_color;
	gl_Position = vec4(b[0].xy, 0.0, 1.0);
}
