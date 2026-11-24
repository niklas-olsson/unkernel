// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Textures on used sampler units that the draws never sample, on Mesa's
// virgl driver (unkernel-check.mjs --drm step t): what Firefox's WebRender
// leaves there. GLES leaves what such a sampler returns undefined, but the
// draw itself must land; WebGL refuses it (GL_INVALID_OPERATION) when the
// texture is attached to the draw framebuffer (a feedback loop) or is of
// another base type than its sampler (float, int, uint), even when the
// shader never samples it, so the renderer must keep such a texture off
// the unit (renderer patch 20). From issue #27's feedback.c.
//
// Surfaceless EGL on GBM (the render node), a GLES 3.0 context, 64x64
// RGBA8 textures A and B that take turns as the framebuffer's colour. The
// shaders sample only in a branch a uniform keeps closed, except in the
// draws marked "sampled", where it is open (the renderer must have put the
// real texture back). Each draw covers the target and is read back:
//
//   into-b-a-bound     into B, A on the fragment sampler's unit
//   into-a-a-bound     into A, A on that unit (the feedback loop): green
//   sampled-a          sampled: into B, A still on that unit, which must
//                      hold A again now that A is not attached: green
//   into-b-unbound     into B, nothing on the unit
//   types              into B, an RGBA8I texture on the unit of the
//                      fragment shader's sampler2D, and A on the unit of
//                      the vertex shader's isampler2D (float on int)
//   sampled-types      sampled: the same units with A on the sampler2D's
//                      and the RGBA8I texture (texel 0 red 100) on the
//                      isampler2D's: A's green plus blue 100
//
// It prints one line per draw, "ok NAME: read ..." or "bad NAME: read ...",
// and exits 0 when all are ok.
//
//   feedback [DEVICE]
#define _GNU_SOURCE
#define EGL_NO_X11
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define SIZE 64

static _Noreturn void die(const char *what)
{
	fprintf(stderr, "feedback: %s (EGL 0x%x, GL 0x%x)\n", what, eglGetError(), glGetError());
	exit(1);
}

static GLuint shader(GLenum kind, const char *src)
{
	GLuint s = glCreateShader(kind);
	GLint ok = 0;
	char log[1024];

	glShaderSource(s, 1, &src, NULL);
	glCompileShader(s);
	glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
	if (!ok) {
		glGetShaderInfoLog(s, sizeof(log), NULL, log);
		fprintf(stderr, "feedback: shader: %s\n", log);
		exit(1);
	}
	return s;
}

static GLuint program(const char *vs, const char *fs)
{
	GLuint p = glCreateProgram();
	GLint ok = 0;

	glAttachShader(p, shader(GL_VERTEX_SHADER, vs));
	glAttachShader(p, shader(GL_FRAGMENT_SHADER, fs));
	glBindAttribLocation(p, 0, "p");
	glLinkProgram(p);
	glGetProgramiv(p, GL_LINK_STATUS, &ok);
	if (!ok)
		die("link");
	glUseProgram(p);
	glUniform1f(glGetUniformLocation(p, "never"), 0.0f);
	return p;
}

// Open (1) or close (0) the program's sampling branch.
static void sampling(GLuint prog, int open)
{
	glUseProgram(prog);
	glUniform1f(glGetUniformLocation(prog, "never"), open ? 1.0f : 0.0f);
}

static GLuint texture(GLenum format)
{
	GLuint t;

	glGenTextures(1, &t);
	glBindTexture(GL_TEXTURE_2D, t);
	glTexStorage2D(GL_TEXTURE_2D, 1, format, SIZE, SIZE);
	// nearest: an integer texture is complete only so
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	return t;
}

// Draw into the target with the colour and read the centre back: the
// colour, or want when the draw samples.
static int draw(const char *name, GLuint prog, GLuint target, const GLfloat *c, const unsigned char *want)
{
	unsigned char px[4] = { 0 };
	int ok = 1;

	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target, 0);
	if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
		die("framebuffer");
	glUseProgram(prog);
	glUniform4fv(glGetUniformLocation(prog, "color"), 1, c);
	glDrawArrays(GL_TRIANGLES, 0, 6);
	glReadPixels(SIZE / 2, SIZE / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
	for (int i = 0; i < 4; i++)
		ok &= px[i] == (want ? want[i] : (unsigned char)(c[i] * 255.0f));
	printf("%s %s: read %u,%u,%u,%u, want %u,%u,%u,%u\n", ok ? "ok" : "bad", name,
	       px[0], px[1], px[2], px[3],
	       want ? want[0] : (unsigned)(c[0] * 255.0f), want ? want[1] : (unsigned)(c[1] * 255.0f),
	       want ? want[2] : (unsigned)(c[2] * 255.0f), want ? want[3] : (unsigned)(c[3] * 255.0f));
	return !ok;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/renderD128";
	static const EGLint ctx_attr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
	static const GLfloat verts[] = { -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1 };
	static const GLfloat red[] = { 1, 0, 0, 1 }, green[] = { 0, 1, 0, 1 }, blue[] = { 0, 0, 1, 1 },
			     yellow[] = { 1, 1, 0, 1 };
	// A as into-a-a-bound left it; that plus the RGBA8I texel's 100 as blue
	static const unsigned char a_green[] = { 0, 255, 0, 255 }, types_want[] = { 0, 255, 100, 255 };
	static const char *vs = "#version 300 es\n"
		"in vec2 p;\n"
		"void main() { gl_Position = vec4(p, 0.0, 1.0); }\n";
	static const char *fs = "#version 300 es\n"
		"precision mediump float;\n"
		"uniform sampler2D s;\n"
		"uniform float never;\n"
		"uniform vec4 color;\n"
		"out vec4 o;\n"
		"void main() { o = color; if (never > 0.5) o = texture(s, vec2(0.5)); }\n";
	// the type case: an isampler2D in the vertex shader, a sampler2D in the fragment shader
	static const char *vs_int = "#version 300 es\n"
		"uniform highp isampler2D si;\n"
		"uniform highp float never;\n"
		"in vec2 p;\n"
		"flat out highp int v;\n"
		"void main() {\n"
		"  v = 0;\n"
		"  if (never > 0.5) v = texelFetch(si, ivec2(0), 0).x;\n"
		"  gl_Position = vec4(p, 0.0, 1.0);\n"
		"}\n";
	static const char *fs_int = "#version 300 es\n"
		"precision mediump float;\n"
		"uniform sampler2D s;\n"
		"uniform highp float never;\n"
		"uniform vec4 color;\n"
		"flat in highp int v;\n"
		"out vec4 o;\n"
		"void main() { o = color; if (never > 0.5) o = texture(s, vec2(0.5)) + vec4(0.0, 0.0, float(v) / 255.0, 0.0); }\n";
	int fd, bad = 0;
	struct gbm_device *gbm;
	EGLDisplay dpy;
	EGLContext ctx;
	GLuint prog, prog_int, vao, vbo, fb, a, b, i8;
	GLenum err;

	fd = open(dev, O_RDWR | O_CLOEXEC);
	if (fd < 0)
		die("open");
	gbm = gbm_create_device(fd);
	if (!gbm)
		die("gbm_create_device");
	dpy = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, NULL);
	if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, NULL, NULL))
		die("eglInitialize");
	if (!eglBindAPI(EGL_OPENGL_ES_API))
		die("eglBindAPI");
	ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ctx_attr);
	if (ctx == EGL_NO_CONTEXT || !eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx))
		die("context");
	printf("renderer %s\n", glGetString(GL_RENDERER));

	// two triangles that cover the target
	glGenVertexArrays(1, &vao);
	glBindVertexArray(vao);
	glGenBuffers(1, &vbo);
	glBindBuffer(GL_ARRAY_BUFFER, vbo);
	glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
	glEnableVertexAttribArray(0);
	glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, NULL);

	a = texture(GL_RGBA8);
	b = texture(GL_RGBA8);
	i8 = texture(GL_RGBA8I);
	{
		static const GLbyte texel[4] = { 100, 0, 0, 0 };

		glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 1, 1, GL_RGBA_INTEGER, GL_BYTE, texel);
	}
	glGenFramebuffers(1, &fb);
	glBindFramebuffer(GL_FRAMEBUFFER, fb);
	glViewport(0, 0, SIZE, SIZE);

	// the sampler on unit 0
	prog = program(vs, fs);
	glUniform1i(glGetUniformLocation(prog, "s"), 0);
	glActiveTexture(GL_TEXTURE0);
	glBindTexture(GL_TEXTURE_2D, a);
	bad += draw("into-b-a-bound", prog, b, red, NULL);
	bad += draw("into-a-a-bound", prog, a, green, NULL);
	// only the framebuffer changes: A must be back on its unit
	sampling(prog, 1);
	bad += draw("sampled-a", prog, b, red, a_green);
	sampling(prog, 0);
	glBindTexture(GL_TEXTURE_2D, 0);
	bad += draw("into-b-unbound", prog, b, blue, NULL);

	// the sampler2D on unit 0 with an integer texture, the isampler2D on unit 1 with a float one
	prog_int = program(vs_int, fs_int);
	glUniform1i(glGetUniformLocation(prog_int, "s"), 0);
	glUniform1i(glGetUniformLocation(prog_int, "si"), 1);
	glActiveTexture(GL_TEXTURE0);
	glBindTexture(GL_TEXTURE_2D, i8);
	glActiveTexture(GL_TEXTURE1);
	glBindTexture(GL_TEXTURE_2D, a);
	bad += draw("types", prog_int, b, yellow, NULL);

	// the same units with textures of their samplers' types, sampled
	glActiveTexture(GL_TEXTURE0);
	glBindTexture(GL_TEXTURE_2D, a);
	glActiveTexture(GL_TEXTURE1);
	glBindTexture(GL_TEXTURE_2D, i8);
	sampling(prog_int, 1);
	bad += draw("sampled-types", prog_int, b, yellow, types_want);

	err = glGetError();
	if (err != GL_NO_ERROR) {
		printf("bad GL error 0x%x\n", err);
		bad++;
	}
	return bad ? 1 : 0;
}
