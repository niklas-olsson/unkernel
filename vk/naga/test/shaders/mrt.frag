#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// An input block and two color outputs.
layout(location = 0) in V { vec4 color; vec2 uv; } vin;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
void main() {
	out0 = vin.color;
	out1 = vec4(vin.uv, gl_FragCoord.z, 1.0);
}
