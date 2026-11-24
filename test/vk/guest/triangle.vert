// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
const vec2 pos[3] = vec2[](vec2(0.0, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5));
void main() { gl_Position = vec4(pos[gl_VertexIndex], 0.0, 1.0); }
