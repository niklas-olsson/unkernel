#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// std140 struct arrays (stride 16 for a 4-byte struct), a scalar before a
// struct array, and a row-major matrix.
struct S { float a; };
layout(std140, set = 0, binding = 0) uniform U {
	float f;
	S s[3];
	layout(row_major) mat4 m;
	vec4 tail;
} u;
layout(location = 0) out vec4 o;
void main() {
	o = u.m * u.tail + vec4(u.f + u.s[1].a + u.s[2].a);
}
