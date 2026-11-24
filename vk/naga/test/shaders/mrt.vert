#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// An output block next to a redeclared gl_PerVertex that writes gl_PointSize.
layout(location = 0) in vec3 pos;
layout(location = 0) out V { vec4 color; vec2 uv; } vout;
out gl_PerVertex { vec4 gl_Position; float gl_PointSize; };
void main() {
	vout.color = vec4(pos, 1.0);
	vout.uv = pos.xy;
	gl_Position = vec4(pos, 1.0);
	gl_PointSize = 2.0;
}
