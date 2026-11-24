#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Push constants, vertex inputs and a gl_PointSize write.
layout(push_constant) uniform PC {
	mat4 transform;
	vec4 color;
} pc;
layout(location = 0) in vec3 pos;
layout(location = 0) out vec4 color;
void main() {
	gl_Position = pc.transform * vec4(pos, 1.0);
	gl_PointSize = 1.0;
	color = pc.color;
}
