// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
// vertices 0-2: a near red quad-ish triangle (z 0.2), 3-5: a far green one (z 0.8), drawn second
const vec3 pos[6] = vec3[](vec3(-0.8, -0.8, 0.2), vec3(0.8, -0.8, 0.2), vec3(0.0, 0.8, 0.2),
                           vec3(-0.8, 0.8, 0.8), vec3(0.8, 0.8, 0.8), vec3(0.0, -0.8, 0.8));
layout(location = 0) out vec4 col;
void main() {
	gl_Position = vec4(pos[gl_VertexIndex], 1.0);
	col = gl_VertexIndex < 3 ? vec4(1, 0, 0, 1) : vec4(0, 1, 0, 1);
}
