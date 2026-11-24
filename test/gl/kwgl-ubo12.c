// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright 2026 the unkernel contributors
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { blocks_per_stage = 12, total_blocks = 2 * blocks_per_stage };

static void require(int condition, const char *step)
{
    if (!condition) {
        fprintf(stderr, "%s failed (EGL=0x%x, GL=0x%x)\n",
                step, eglGetError(), glGetError());
        exit(1);
    }
}

static void check_gl(const char *step)
{
    GLenum error = glGetError();
    if (error != GL_NO_ERROR) {
        fprintf(stderr, "%s raised GL error 0x%x\n", step, error);
        exit(1);
    }
}

static GLuint compile_shader(GLenum stage, const char *body)
{
    const int first = stage == GL_VERTEX_SHADER ? 0 : blocks_per_stage;
    char declarations[1024] = "";
    char checks[1024] = "";
    size_t declaration_len = 0, check_len = 0;
    for (int i = first; i < first + blocks_per_stage; i++) {
        declaration_len += snprintf(declarations + declaration_len,
                                    sizeof declarations - declaration_len,
                                    "layout(std140) uniform Block%d { uint value%d; };\n", i, i);
        // Validate each binding independently. A total alone would miss swaps.
        check_len += snprintf(checks + check_len, sizeof checks - check_len,
                              "  if (value%d != %du + phase * 64u) return false;\n", i, i + 1);
    }
    const char *parts[] = {
        "#version 300 es\nprecision highp float;\nprecision highp int;\n",
        declarations, "bool valid(uint phase) {\n", checks, "  return true;\n}\n", body,
    };
    GLuint shader = glCreateShader(stage);
    glShaderSource(shader, sizeof parts / sizeof parts[0], parts, NULL);
    glCompileShader(shader);
    GLint compiled = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if (!compiled) {
        char log[2048];
        glGetShaderInfoLog(shader, sizeof log, NULL, log);
        fprintf(stderr, "%s shader: %s\n", stage == GL_VERTEX_SHADER ? "vertex" : "fragment", log);
        exit(1);
    }
    return shader;
}

static GLuint make_program(void)
{
    const char *vertex =
        "flat out int vertexResult;\n"
        "void main() {\n"
        "  uint phase = value0 / 64u;\n"
        "  vertexResult = (phase < 2u && valid(phase)) ? int(phase) : -1;\n"
        "  vec2 position = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);\n"
        "  gl_Position = vec4(position, 0.0, 1.0);\n"
        "}\n";
    const char *fragment =
        "flat in int vertexResult;\n"
        "out vec4 color;\n"
        "void main() {\n"
        "  uint phase = value12 / 64u;\n"
        "  if (phase >= 2u || int(phase) != vertexResult || !valid(phase))\n"
        "    color = vec4(1.0, 0.0, 1.0, 1.0);\n"
        "  else\n"
        "    color = phase == 0u ? vec4(1.0, 0.0, 0.0, 1.0) : vec4(0.0, 1.0, 0.0, 1.0);\n"
        "}\n";
    GLuint program = glCreateProgram();
    glAttachShader(program, compile_shader(GL_VERTEX_SHADER, vertex));
    glAttachShader(program, compile_shader(GL_FRAGMENT_SHADER, fragment));
    glLinkProgram(program);
    GLint linked = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    if (!linked) {
        char log[2048];
        glGetProgramInfoLog(program, sizeof log, NULL, log);
        fprintf(stderr, "program link: %s\n", log);
        exit(1);
    }
    return program;
}

static void expect_pixels(const char *draw, const GLubyte expected[8])
{
    GLubyte pixels[8] = {0};
    glReadPixels(0, 0, 2, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    check_gl(draw);
    printf("%s: [%u,%u,%u,%u] [%u,%u,%u,%u]\n", draw,
           pixels[0], pixels[1], pixels[2], pixels[3], pixels[4], pixels[5], pixels[6], pixels[7]);
    if (memcmp(pixels, expected, sizeof pixels) != 0) {
        fprintf(stderr, "%s returned unexpected pixels\n", draw);
        exit(1);
    }
}

int main(int argc, char **argv)
{
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
    require(display != EGL_NO_DISPLAY && eglInitialize(display, NULL, NULL), "surfaceless EGL init");
    require(eglBindAPI(EGL_OPENGL_ES_API), "bind GLES API");
    const EGLint config_attrs[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE,
    };
    EGLConfig config;
    EGLint configs = 0;
    require(eglChooseConfig(display, config_attrs, &config, 1, &configs) && configs == 1,
            "choose GLES3 RGBA pbuffer config");
    const EGLint surface_attrs[] = {EGL_WIDTH, 2, EGL_HEIGHT, 1, EGL_NONE};
    const EGLint context_attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    EGLSurface surface = eglCreatePbufferSurface(display, config, surface_attrs);
    require(surface != EGL_NO_SURFACE, "create pbuffer");
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attrs);
    require(context != EGL_NO_CONTEXT, "create GLES3 context");
    require(eglMakeCurrent(display, surface, surface, context), "make GLES3 context current");
    const char *renderer = (const char *)glGetString(GL_RENDERER);
    require(renderer != NULL, "query renderer");
    printf("GL_RENDERER %s\nGL_VERSION %s\n", renderer, glGetString(GL_VERSION));
    if (argc > 1 && !strstr(renderer, argv[1])) {
        fprintf(stderr, "Expected renderer containing %s\n", argv[1]);
        return 1;
    }

    GLint major, vs, fs, combined, bindings;
    glGetIntegerv(GL_MAJOR_VERSION, &major);
    glGetIntegerv(GL_MAX_VERTEX_UNIFORM_BLOCKS, &vs);
    glGetIntegerv(GL_MAX_FRAGMENT_UNIFORM_BLOCKS, &fs);
    glGetIntegerv(GL_MAX_COMBINED_UNIFORM_BLOCKS, &combined);
    glGetIntegerv(GL_MAX_UNIFORM_BUFFER_BINDINGS, &bindings);
    check_gl("query GLES limits");
    printf("UBO limits: vertex=%d fragment=%d combined=%d bindings=%d\n", vs, fs, combined, bindings);
    require(major >= 3 && vs >= blocks_per_stage && fs >= blocks_per_stage &&
            combined >= total_blocks && bindings >= total_blocks, "GLES3 uniform block limits");
    require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "pbuffer framebuffer");

    GLuint program = make_program();
    GLint active;
    glGetProgramiv(program, GL_ACTIVE_UNIFORM_BLOCKS, &active);
    require(active == total_blocks, "24 active uniform blocks");
    glUseProgram(program);
    GLuint buffers[total_blocks];
    glGenBuffers(total_blocks, buffers);
    for (int i = 0; i < total_blocks; i++) {
        char name[24];
        snprintf(name, sizeof name, "Block%d", i);
        GLuint index = glGetUniformBlockIndex(program, name);
        require(index != GL_INVALID_INDEX, name);
        GLint in_vertex, in_fragment, size;
        glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER, &in_vertex);
        glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER, &in_fragment);
        glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_DATA_SIZE, &size);
        const GLuint data[4] = {(GLuint)i + 1, 0, 0, 0};
        require((in_vertex != 0) == (i < blocks_per_stage) &&
                (in_fragment != 0) == (i >= blocks_per_stage) && size == sizeof data, name);
        glUniformBlockBinding(program, index, i);
        glBindBuffer(GL_UNIFORM_BUFFER, buffers[i]);
        glBufferData(GL_UNIFORM_BUFFER, sizeof data, data, GL_DYNAMIC_DRAW);
        glBindBufferBase(GL_UNIFORM_BUFFER, i, buffers[i]);
    }
    check_gl("bind 24 active uniform blocks");
    glDisable(GL_DITHER);
    glViewport(0, 0, 2, 1);
    glClearColor(0, 0, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(0, 0, 1, 1);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    expect_pixels("draw 1", (const GLubyte[8]){255, 0, 0, 255, 0, 0, 255, 255});

    for (int i = 0; i < total_blocks; i++) {
        const GLuint value = (GLuint)i + 65;
        glBindBuffer(GL_UNIFORM_BUFFER, buffers[i]);
        glBufferSubData(GL_UNIFORM_BUFFER, 0, sizeof value, &value);
    }
    glScissor(1, 0, 1, 1);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    expect_pixels("draw 2", (const GLubyte[8]){255, 0, 0, 255, 0, 255, 0, 255});
    printf("PASS: %d active vertex blocks, %d active fragment blocks, 24 separate UBOs\n",
           blocks_per_stage, blocks_per_stage);
    eglTerminate(display);
    return 0;
}
