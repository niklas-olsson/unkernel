#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A vertex shader writing gl_ClipDistance, which WGSL core lacks.
layout(location = 0) in vec4 pos;
void main() {
	gl_Position = pos;
	gl_ClipDistance[0] = pos.x;
}
