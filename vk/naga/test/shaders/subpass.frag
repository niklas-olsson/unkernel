#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// An input attachment (subpassLoad), gl_PointCoord, a write-only buffer.
layout(input_attachment_index = 0, set = 0, binding = 0) uniform subpassInput inColor;
layout(std430, set = 0, binding = 1) writeonly buffer Out { vec4 v[]; } outBuf;
layout(location = 0) out vec4 o;
void main() {
	vec4 c = subpassLoad(inColor);
	outBuf.v[0] = c;
	o = c + vec4(gl_PointCoord, 0.0, 0.0);
}
