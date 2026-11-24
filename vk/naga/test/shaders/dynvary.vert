#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Dynamically indexed array varyings and a struct varying (GTK 4.18's
// border shader, struct Rect { vec4 bounds; }) used at two locations.
struct Rect { vec4 bounds; };
layout(location = 0) in vec4 pos;
layout(location = 0) flat out vec4 corners[3];
layout(location = 3) flat out Rect a;
layout(location = 4) flat out Rect b;
void main() {
	for (int i = 0; i < 3; i++) corners[i] = pos * float(i);
	corners[gl_VertexIndex % 3] = vec4(1.0);
	a.bounds = pos;
	b = Rect(pos.yxwz);
	gl_Position = pos;
}
