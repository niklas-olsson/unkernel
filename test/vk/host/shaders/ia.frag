// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(input_attachment_index = 0, set = 0, binding = 0) uniform subpassInput inA;
layout(location = 0) out vec4 o;
void main() { o = subpassLoad(inA).bgra; }
