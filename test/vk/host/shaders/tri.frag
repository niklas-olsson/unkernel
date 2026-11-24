// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(push_constant) uniform P { vec4 color; } pc;
layout(location = 0) out vec4 o;
void main() { o = pc.color; }
