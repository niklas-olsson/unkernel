// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
void main() { vec2 p = vec2((gl_VertexIndex << 1) & 2, gl_VertexIndex & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }
