// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(location = 0) flat in vec3 fcol;
layout(location = 0) out vec4 color;
void main() { color = vec4(fcol, 1.0); }
