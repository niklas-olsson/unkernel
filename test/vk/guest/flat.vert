// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
// pos is fed by a 3-component attribute: its w must read 1
layout(location = 0) in vec4 pos;
layout(location = 1) in vec3 col;
layout(location = 0) flat out vec3 fcol;
void main() {
	gl_Position = vec4(pos.xy, 0.0, pos.w);
	fcol = col;
}
