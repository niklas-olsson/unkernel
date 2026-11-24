// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(location = 0) in vec2 pos;
layout(location = 1) out vec4 col;
void main() { col = gl_VertexIndex == 0 ? vec4(1, 0, 0, 1) : gl_VertexIndex == 1 ? vec4(0, 1, 0, 1) : vec4(0, 0, 1, 1); gl_Position = vec4(pos, 0.0, 1.0); }
