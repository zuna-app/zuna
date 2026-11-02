#include "dmabuf_cuda.h"

#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <libavutil/error.h>

// --- What this needs from EGL, OpenGL, CUDA and GBM, as their headers have it ---

typedef void *EGLDisplay;
typedef void *EGLContext;
typedef void *EGLImage;
typedef void *EGLDeviceEXT;
typedef int32_t EGLint;
typedef unsigned int EGLBoolean;
typedef unsigned int EGLenum;

#define EGL_NONE 0x3038
#define EGL_VENDOR 0x3053
#define EGL_EXTENSIONS 0x3055
#define EGL_HEIGHT 0x3056
#define EGL_WIDTH 0x3057
#define EGL_OPENGL_API 0x30A2
#define EGL_CONTEXT_MAJOR_VERSION 0x3098
#define EGL_CONTEXT_MINOR_VERSION 0x30FB
#define EGL_PLATFORM_DEVICE_EXT 0x313F
#define EGL_DRM_DEVICE_FILE_EXT 0x3233
#define EGL_LINUX_DMA_BUF_EXT 0x3270
#define EGL_LINUX_DRM_FOURCC_EXT 0x3271
#define EGL_DRM_RENDER_NODE_FILE_EXT 0x3377

// Each plane's FD, offset and pitch, then its modifier's low and high halves.
static const EGLint plane_attributes[4][5] = {
    {0x3272, 0x3273, 0x3274, 0x3443, 0x3444},
    {0x3275, 0x3276, 0x3277, 0x3445, 0x3446},
    {0x3278, 0x3279, 0x327A, 0x3447, 0x3448},
    {0x3440, 0x3441, 0x3442, 0x3449, 0x344A},
};

typedef unsigned int GLuint;
typedef unsigned int GLenum;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef int GLsizei;
typedef float GLfloat;

#define GL_TEXTURE_2D 0x0DE1
#define GL_SCISSOR_TEST 0x0C11
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_COLOR_BUFFER_BIT 0x00004000
#define GL_RGBA8 0x8058
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_COLOR_ATTACHMENT0 0x8CE0

typedef int CUresult;
typedef int CUdevice;
typedef unsigned long long CUdeviceptr;
typedef struct CUctx_st *CUcontext;
typedef struct CUarray_st *CUarray;
typedef struct CUstream_st *CUstream;
typedef struct CUgraphicsResource_st *CUgraphicsResource;

#define CU_MEMORYTYPE_HOST 1
#define CU_MEMORYTYPE_DEVICE 2
#define CU_MEMORYTYPE_ARRAY 3
#define CU_GRAPHICS_REGISTER_FLAGS_READ_ONLY 1

typedef struct {
    size_t srcXInBytes, srcY;
    int srcMemoryType;
    const void *srcHost;
    CUdeviceptr srcDevice;
    CUarray srcArray;
    size_t srcPitch;
    size_t dstXInBytes, dstY;
    int dstMemoryType;
    void *dstHost;
    CUdeviceptr dstDevice;
    CUarray dstArray;
    size_t dstPitch;
    size_t WidthInBytes, Height;
} CUDA_MEMCPY2D;

struct gbm_device;
struct gbm_bo;
#define GBM_BO_USE_RENDERING (1 << 2)

#define FOURCC(a, b, c, d) ((uint32_t)(a) | ((uint32_t)(b) << 8) | ((uint32_t)(c) << 16) | ((uint32_t)(d) << 24))
#define DRM_FORMAT_MOD_LINEAR 0ULL
#define DRM_FORMAT_MOD_INVALID 0x00ffffffffffffffULL

static struct {
    int tried, loaded;
    EGLDisplay display;
    void *(*GetProcAddress)(const char *);
    EGLBoolean (*Initialize)(EGLDisplay, EGLint *, EGLint *);
    const char *(*QueryString)(EGLDisplay, EGLint);
    EGLBoolean (*BindAPI)(EGLenum);
    EGLContext (*CreateContext)(EGLDisplay, void *, EGLContext, const EGLint *);
    EGLBoolean (*DestroyContext)(EGLDisplay, EGLContext);
    EGLBoolean (*MakeCurrent)(EGLDisplay, void *, void *, EGLContext);
    EGLint (*GetError)(void);
    EGLBoolean (*QueryDevicesEXT)(EGLint, EGLDeviceEXT *, EGLint *);
    const char *(*QueryDeviceStringEXT)(EGLDeviceEXT, EGLint);
    EGLDisplay (*GetPlatformDisplayEXT)(EGLenum, void *, const EGLint *);
    EGLBoolean (*QueryDmaBufModifiersEXT)(EGLDisplay, EGLint, EGLint, uint64_t *, EGLBoolean *, EGLint *);
    EGLImage (*CreateImageKHR)(EGLDisplay, EGLContext, EGLenum, void *, const EGLint *);
    EGLBoolean (*DestroyImageKHR)(EGLDisplay, EGLImage);
} egl;

static struct {
    void (*GenTextures)(GLsizei, GLuint *);
    void (*DeleteTextures)(GLsizei, const GLuint *);
    void (*BindTexture)(GLenum, GLuint);
    void (*TexStorage2D)(GLenum, GLsizei, GLenum, GLsizei, GLsizei);
    void (*EGLImageTargetTexture2DOES)(GLenum, void *);
    void (*GenFramebuffers)(GLsizei, GLuint *);
    void (*DeleteFramebuffers)(GLsizei, const GLuint *);
    void (*BindFramebuffer)(GLenum, GLuint);
    void (*FramebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, GLint);
    GLenum (*CheckFramebufferStatus)(GLenum);
    void (*BlitFramebuffer)(GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum);
    void (*Enable)(GLenum);
    void (*Disable)(GLenum);
    void (*Scissor)(GLint, GLint, GLsizei, GLsizei);
    void (*ClearColor)(GLfloat, GLfloat, GLfloat, GLfloat);
    void (*Clear)(GLbitfield);
    void (*Finish)(void);
    GLenum (*GetError)(void);
} gl;

static struct {
    CUresult (*Init)(unsigned);
    CUresult (*DeviceGet)(CUdevice *, int);
    CUresult (*CtxCreate)(CUcontext *, unsigned, CUdevice);
    CUresult (*CtxDestroy)(CUcontext);
    CUresult (*CtxPushCurrent)(CUcontext);
    CUresult (*CtxPopCurrent)(CUcontext *);
    CUresult (*CtxSynchronize)(void);
    CUresult (*MemAllocPitch)(CUdeviceptr *, size_t *, size_t, size_t, unsigned);
    CUresult (*MemFree)(CUdeviceptr);
    CUresult (*Memcpy2D)(const CUDA_MEMCPY2D *);
    CUresult (*GraphicsGLRegisterImage)(CUgraphicsResource *, GLuint, GLenum, unsigned);
    CUresult (*GraphicsUnregisterResource)(CUgraphicsResource);
    CUresult (*GraphicsMapResources)(unsigned, CUgraphicsResource *, CUstream);
    CUresult (*GraphicsUnmapResources)(unsigned, CUgraphicsResource *, CUstream);
    CUresult (*GraphicsSubResourceGetMappedArray)(CUarray *, CUgraphicsResource, unsigned, unsigned);
    CUresult (*GetErrorName)(CUresult, const char **);
} cu;

static int fail(const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    fputs("[dmabuf] ", stderr);
    vfprintf(stderr, format, arguments);
    fputc('\n', stderr);
    va_end(arguments);
    return AVERROR_EXTERNAL;
}

static int cuda_failed(CUresult code, const char *doing) {
    const char *name = NULL;
    if (cu.GetErrorName) cu.GetErrorName(code, &name);
    return fail("%s: %s", doing, name ? name : "unknown CUDA error");
}

static int load(void) {
    if (egl.tried) return egl.loaded ? 0 : AVERROR_EXTERNAL;
    egl.tried = 1;
    void *libegl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!libegl) return fail("Loading EGL: %s", dlerror());
    void *libcuda = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!libcuda) return fail("Loading CUDA: %s", dlerror());

#define FROM(library, field, symbol) \
    if (!(*(void **)&field = dlsym(library, symbol))) return fail("No %s", symbol)
#define EXTENSION(field, symbol) \
    if (!(*(void **)&field = egl.GetProcAddress(symbol))) return fail("No %s", symbol)

    FROM(libegl, egl.GetProcAddress, "eglGetProcAddress");
    FROM(libegl, egl.Initialize, "eglInitialize");
    FROM(libegl, egl.QueryString, "eglQueryString");
    FROM(libegl, egl.BindAPI, "eglBindAPI");
    FROM(libegl, egl.CreateContext, "eglCreateContext");
    FROM(libegl, egl.DestroyContext, "eglDestroyContext");
    FROM(libegl, egl.MakeCurrent, "eglMakeCurrent");
    FROM(libegl, egl.GetError, "eglGetError");
    EXTENSION(egl.QueryDevicesEXT, "eglQueryDevicesEXT");
    EXTENSION(egl.QueryDeviceStringEXT, "eglQueryDeviceStringEXT");
    EXTENSION(egl.GetPlatformDisplayEXT, "eglGetPlatformDisplayEXT");
    EXTENSION(egl.QueryDmaBufModifiersEXT, "eglQueryDmaBufModifiersEXT");
    EXTENSION(egl.CreateImageKHR, "eglCreateImageKHR");
    EXTENSION(egl.DestroyImageKHR, "eglDestroyImageKHR");

    EXTENSION(gl.GenTextures, "glGenTextures");
    EXTENSION(gl.DeleteTextures, "glDeleteTextures");
    EXTENSION(gl.BindTexture, "glBindTexture");
    EXTENSION(gl.TexStorage2D, "glTexStorage2D");
    EXTENSION(gl.EGLImageTargetTexture2DOES, "glEGLImageTargetTexture2DOES");
    EXTENSION(gl.GenFramebuffers, "glGenFramebuffers");
    EXTENSION(gl.DeleteFramebuffers, "glDeleteFramebuffers");
    EXTENSION(gl.BindFramebuffer, "glBindFramebuffer");
    EXTENSION(gl.FramebufferTexture2D, "glFramebufferTexture2D");
    EXTENSION(gl.CheckFramebufferStatus, "glCheckFramebufferStatus");
    EXTENSION(gl.BlitFramebuffer, "glBlitFramebuffer");
    EXTENSION(gl.Enable, "glEnable");
    EXTENSION(gl.Disable, "glDisable");
    EXTENSION(gl.Scissor, "glScissor");
    EXTENSION(gl.ClearColor, "glClearColor");
    EXTENSION(gl.Clear, "glClear");
    EXTENSION(gl.Finish, "glFinish");
    EXTENSION(gl.GetError, "glGetError");

    FROM(libcuda, cu.Init, "cuInit");
    FROM(libcuda, cu.DeviceGet, "cuDeviceGet");
    FROM(libcuda, cu.CtxCreate, "cuCtxCreate_v2");
    FROM(libcuda, cu.CtxDestroy, "cuCtxDestroy_v2");
    FROM(libcuda, cu.CtxPushCurrent, "cuCtxPushCurrent_v2");
    FROM(libcuda, cu.CtxPopCurrent, "cuCtxPopCurrent_v2");
    FROM(libcuda, cu.CtxSynchronize, "cuCtxSynchronize");
    FROM(libcuda, cu.MemAllocPitch, "cuMemAllocPitch_v2");
    FROM(libcuda, cu.MemFree, "cuMemFree_v2");
    FROM(libcuda, cu.Memcpy2D, "cuMemcpy2D_v2");
    FROM(libcuda, cu.GraphicsGLRegisterImage, "cuGraphicsGLRegisterImage");
    FROM(libcuda, cu.GraphicsUnregisterResource, "cuGraphicsUnregisterResource");
    FROM(libcuda, cu.GraphicsMapResources, "cuGraphicsMapResources");
    FROM(libcuda, cu.GraphicsUnmapResources, "cuGraphicsUnmapResources");
    FROM(libcuda, cu.GraphicsSubResourceGetMappedArray, "cuGraphicsSubResourceGetMappedArray");
    FROM(libcuda, cu.GetErrorName, "cuGetErrorName");
    egl.loaded = 1;
    return 0;
}

static int has_extension(const char *list, const char *name) {
    size_t length = strlen(name);
    for (const char *at = list; at && (at = strstr(at, name)); at += length) {
        if ((at == list || at[-1] == ' ') && (at[length] == ' ' || at[length] == '\0')) return 1;
    }
    return 0;
}

// The display on the GPU with this render node, made once and kept, as EGL keeps
// one per device anyway.
static int open_display(const char *render_node) {
    if (egl.display) return 0;
    int result = load();
    if (result < 0) return result;

    EGLDeviceEXT devices[16];
    EGLint count = 0;
    if (!egl.QueryDevicesEXT(16, devices, &count)) return fail("eglQueryDevicesEXT: 0x%x", egl.GetError());
    for (EGLint i = 0; i < count && !egl.display; i++) {
        const char *node = egl.QueryDeviceStringEXT(devices[i], EGL_DRM_RENDER_NODE_FILE_EXT);
        if (!node || (render_node && strcmp(node, render_node) != 0)) continue;
        EGLDisplay display = egl.GetPlatformDisplayEXT(EGL_PLATFORM_DEVICE_EXT, devices[i], NULL);
        if (!display || !egl.Initialize(display, NULL, NULL)) continue;
        const char *extensions = egl.QueryString(display, EGL_EXTENSIONS);
        if (has_extension(extensions, "EGL_EXT_image_dma_buf_import_modifiers") &&
            has_extension(extensions, "EGL_KHR_surfaceless_context") &&
            has_extension(extensions, "EGL_KHR_no_config_context"))
            egl.display = display;
    }
    if (!egl.display) return fail("No EGL device at %s can import DMA-BUFs", render_node ? render_node : "any render node");
    return 0;
}

ZUNA_API int zuna_dmabuf_modifiers(const char *render_node, uint32_t fourcc, uint64_t *modifiers, int capacity) {
    int result = open_display(render_node);
    if (result < 0) return result;
    uint64_t found[64];
    EGLBoolean external_only[64];
    EGLint count = 0;
    if (!egl.QueryDmaBufModifiersEXT(egl.display, (EGLint)fourcc, 64, found, external_only, &count))
        return fail("eglQueryDmaBufModifiersEXT: 0x%x", egl.GetError());

    // Only those a 2D texture can take. Linear goes last, since a GPU draws into its
    // own tiling faster.
    int kept = 0;
    for (int linear = 0; linear < 2; linear++) {
        for (EGLint i = 0; i < count && kept < capacity; i++) {
            if (!external_only[i] && (found[i] == DRM_FORMAT_MOD_LINEAR) == linear) modifiers[kept++] = found[i];
        }
    }
    return kept;
}

// --- Importing ---

struct zuna_importer {
    CUcontext cuda;
    EGLContext context;
    int source_width;
    int source_height;
    int width;
    int height;
    int ready;
    GLuint source;
    GLuint target;
    GLuint read;
    GLuint draw;
    CUgraphicsResource resource;
};

int zuna_importer_open(const char *render_node, void *cuda_context, int source_width, int source_height, int width,
                       int height, zuna_importer **out) {
    int result = open_display(render_node);
    if (result < 0) return result;
    if (!egl.BindAPI(EGL_OPENGL_API)) return fail("eglBindAPI: 0x%x", egl.GetError());
    // No config and no surface: it only ever draws into textures.
    static const EGLint attributes[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3, EGL_NONE};
    EGLContext context = egl.CreateContext(egl.display, NULL, NULL, attributes);
    if (!context) return fail("eglCreateContext: 0x%x", egl.GetError());

    zuna_importer *importer = calloc(1, sizeof *importer);
    if (!importer) {
        egl.DestroyContext(egl.display, context);
        return AVERROR(ENOMEM);
    }
    importer->cuda = cuda_context;
    importer->context = context;
    importer->source_width = source_width;
    importer->source_height = source_height;
    importer->width = width;
    importer->height = height;
    *out = importer;
    return 0;
}

// A context is current per thread and per API, and the API is per thread too.
static int make_current(zuna_importer *importer) {
    static __thread EGLContext current;
    if (current == importer->context) return 0;
    if (!egl.BindAPI(EGL_OPENGL_API) || !egl.MakeCurrent(egl.display, NULL, NULL, importer->context))
        return fail("eglMakeCurrent: 0x%x", egl.GetError());
    current = importer->context;
    return 0;
}

static EGLImage import(const zuna_importer *importer, const zuna_dmabuf *dmabuf) {
    EGLint attributes[7 + 4 * 10];
    int n = 0;
    attributes[n++] = EGL_WIDTH;
    attributes[n++] = importer->source_width;
    attributes[n++] = EGL_HEIGHT;
    attributes[n++] = importer->source_height;
    attributes[n++] = EGL_LINUX_DRM_FOURCC_EXT;
    attributes[n++] = (EGLint)dmabuf->fourcc;
    for (int plane = 0; plane < dmabuf->planes && plane < 4; plane++) {
        const EGLint *names = plane_attributes[plane];
        attributes[n++] = names[0];
        attributes[n++] = dmabuf->fd[plane];
        attributes[n++] = names[1];
        attributes[n++] = (EGLint)dmabuf->offset[plane];
        attributes[n++] = names[2];
        attributes[n++] = (EGLint)dmabuf->pitch[plane];
        if (dmabuf->modifier != DRM_FORMAT_MOD_INVALID) {
            attributes[n++] = names[3];
            attributes[n++] = (EGLint)(dmabuf->modifier & 0xffffffff);
            attributes[n++] = names[4];
            attributes[n++] = (EGLint)(dmabuf->modifier >> 32);
        }
    }
    attributes[n++] = EGL_NONE;
    return egl.CreateImageKHR(egl.display, NULL, EGL_LINUX_DMA_BUF_EXT, NULL, attributes);
}

// On the thread that copies, which is the one the context is current on.
static int prepare(zuna_importer *importer) {
    gl.GenTextures(1, &importer->source);
    gl.GenTextures(1, &importer->target);
    gl.BindTexture(GL_TEXTURE_2D, importer->target);
    gl.TexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, importer->width, importer->height);
    gl.GenFramebuffers(1, &importer->read);
    gl.GenFramebuffers(1, &importer->draw);
    gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, importer->draw);
    gl.FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, importer->target, 0);
    if (gl.CheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        return fail("OpenGL can't draw into the texture CUDA reads from");

    CUcontext ignored;
    cu.CtxPushCurrent(importer->cuda);
    CUresult code = cu.GraphicsGLRegisterImage(&importer->resource, importer->target, GL_TEXTURE_2D,
                                               CU_GRAPHICS_REGISTER_FLAGS_READ_ONLY);
    cu.CtxPopCurrent(&ignored);
    if (code != 0) return cuda_failed(code, "Registering the texture with CUDA");
    importer->ready = 1;
    return 0;
}

int zuna_importer_copy(zuna_importer *importer, const zuna_dmabuf *dmabuf, uint64_t destination, size_t pitch) {
    int result = make_current(importer);
    if (result < 0) return result;
    if (!importer->ready && (result = prepare(importer)) < 0) return result;

    EGLImage image = import(importer, dmabuf);
    if (!image)
        return fail("Importing a DMA-BUF with modifier 0x%llx: EGL error 0x%x", (unsigned long long)dmabuf->modifier,
                    egl.GetError());
    // The blit also turns the compositor's channel order into RGBA, and makes it smaller if that's wanted.
    int width = importer->width, height = importer->height;
    int source_width = importer->source_width, source_height = importer->source_height;
    gl.BindTexture(GL_TEXTURE_2D, importer->source);
    gl.EGLImageTargetTexture2DOES(GL_TEXTURE_2D, image);
    gl.BindFramebuffer(GL_READ_FRAMEBUFFER, importer->read);
    gl.FramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, importer->source, 0);
    gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, importer->draw);
    gl.BlitFramebuffer(0, 0, source_width, source_height, 0, 0, width, height, GL_COLOR_BUFFER_BIT,
                       source_width == width && source_height == height ? GL_NEAREST : GL_LINEAR);
    // The texture keeps the buffer for as long as the blit needs it.
    egl.DestroyImageKHR(egl.display, image);
    GLenum error = gl.GetError();
    if (error) return fail("Copying a frame in OpenGL: error 0x%x", error);

    // Mapping waits for the blit, and synchronizing waits for the copy, so when this
    // returns nothing reads the DMA-BUF any more.
    CUcontext ignored;
    cu.CtxPushCurrent(importer->cuda);
    CUresult code = cu.GraphicsMapResources(1, &importer->resource, NULL);
    if (code == 0) {
        CUarray array = NULL;
        code = cu.GraphicsSubResourceGetMappedArray(&array, importer->resource, 0, 0);
        if (code == 0) {
            CUDA_MEMCPY2D copy = {
                .srcMemoryType = CU_MEMORYTYPE_ARRAY,
                .srcArray = array,
                .dstMemoryType = CU_MEMORYTYPE_DEVICE,
                .dstDevice = destination,
                .dstPitch = pitch,
                .WidthInBytes = (size_t)width * 4,
                .Height = (size_t)height,
            };
            code = cu.Memcpy2D(&copy);
        }
        CUresult unmapped = cu.GraphicsUnmapResources(1, &importer->resource, NULL);
        if (code == 0) code = unmapped;
        if (code == 0) code = cu.CtxSynchronize();
    }
    cu.CtxPopCurrent(&ignored);
    return code == 0 ? 0 : cuda_failed(code, "Copying a frame into CUDA");
}

void zuna_importer_close(zuna_importer *importer) {
    if (!importer) return;
    if (importer->resource) {
        CUcontext ignored;
        cu.CtxPushCurrent(importer->cuda);
        cu.GraphicsUnregisterResource(importer->resource);
        cu.CtxPopCurrent(&ignored);
    }
    // It may still be current on the capture's thread, and then EGL deletes it, and
    // what was made in it, once it no longer is.
    egl.DestroyContext(egl.display, importer->context);
    free(importer);
}

// --- Checking it without a compositor: DMA-BUFs of every modifier, made here ---

static struct {
    struct gbm_device *(*create_device)(int);
    void (*device_destroy)(struct gbm_device *);
    struct gbm_bo *(*bo_create_with_modifiers2)(struct gbm_device *, uint32_t, uint32_t, uint32_t, const uint64_t *,
                                                unsigned, uint32_t);
    int (*bo_get_fd)(struct gbm_bo *);
    uint32_t (*bo_get_stride_for_plane)(struct gbm_bo *, int);
    uint32_t (*bo_get_offset)(struct gbm_bo *, int);
    uint64_t (*bo_get_modifier)(struct gbm_bo *);
    int (*bo_get_plane_count)(struct gbm_bo *);
    void (*bo_destroy)(struct gbm_bo *);
} gbm;

static int load_gbm(void) {
    void *library = dlopen("libgbm.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) return fail("Loading GBM: %s", dlerror());
    FROM(library, gbm.create_device, "gbm_create_device");
    FROM(library, gbm.device_destroy, "gbm_device_destroy");
    FROM(library, gbm.bo_create_with_modifiers2, "gbm_bo_create_with_modifiers2");
    FROM(library, gbm.bo_get_fd, "gbm_bo_get_fd");
    FROM(library, gbm.bo_get_stride_for_plane, "gbm_bo_get_stride_for_plane");
    FROM(library, gbm.bo_get_offset, "gbm_bo_get_offset");
    FROM(library, gbm.bo_get_modifier, "gbm_bo_get_modifier");
    FROM(library, gbm.bo_get_plane_count, "gbm_bo_get_plane_count");
    FROM(library, gbm.bo_destroy, "gbm_bo_destroy");
    return 0;
}

static const uint8_t quadrant_colours[4][3] = {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 0}};

// A colour in each quarter, counted in the buffer's own rows, so a flip would show.
static int fill_quadrants(zuna_importer *importer, const zuna_dmabuf *dmabuf) {
    EGLImage image = import(importer, dmabuf);
    if (!image) return fail("Importing it to draw into: EGL error 0x%x", egl.GetError());
    GLuint texture, framebuffer;
    gl.GenTextures(1, &texture);
    gl.BindTexture(GL_TEXTURE_2D, texture);
    gl.EGLImageTargetTexture2DOES(GL_TEXTURE_2D, image);
    gl.GenFramebuffers(1, &framebuffer);
    gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
    gl.FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
    int complete = gl.CheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    if (complete) {
        int half_width = importer->width / 2, half_height = importer->height / 2;
        gl.Enable(GL_SCISSOR_TEST);
        for (int quadrant = 0; quadrant < 4; quadrant++) {
            const uint8_t *colour = quadrant_colours[quadrant];
            gl.Scissor((quadrant % 2) * half_width, (quadrant / 2) * half_height, half_width, half_height);
            gl.ClearColor(colour[0] / 255.0f, colour[1] / 255.0f, colour[2] / 255.0f, 1.0f);
            gl.Clear(GL_COLOR_BUFFER_BIT);
        }
        gl.Disable(GL_SCISSOR_TEST);
        gl.Finish();
    }
    gl.DeleteFramebuffers(1, &framebuffer);
    gl.DeleteTextures(1, &texture);
    egl.DestroyImageKHR(egl.display, image);
    return complete ? 0 : fail("OpenGL can't draw into it");
}

static void append(char *report, int size, const char *format, ...) {
    size_t used = strlen(report);
    if (used + 1 >= (size_t)size) return;
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(report + used, size - used, format, arguments);
    va_end(arguments);
}

static double now_ms(void) {
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC, &time);
    return time.tv_sec * 1000.0 + time.tv_nsec / 1e6;
}

ZUNA_API int zuna_dmabuf_check(const char *render_node, char *report, int size) {
    enum { WIDTH = 2560, HEIGHT = 1440, ROUNDS = 120 };
    const uint32_t fourcc = FOURCC('X', 'R', '2', '4');
    report[0] = '\0';

    uint64_t modifiers[64];
    int count = zuna_dmabuf_modifiers(render_node, fourcc, modifiers, 64);
    if (count < 0) return count;
    append(report, size, "EGL from %s offers %d modifiers for XR24\n", egl.QueryString(egl.display, EGL_VENDOR), count);
    int result = load_gbm();
    if (result < 0) return result;

    int fd = open(render_node, O_RDWR | O_CLOEXEC);
    if (fd < 0) return fail("Opening %s", render_node);
    struct gbm_device *device = gbm.create_device(fd);
    CUdevice cuda_device;
    CUcontext cuda = NULL, ignored;
    CUdeviceptr frame = 0;
    size_t pitch = 0;
    zuna_importer *importer = NULL;
    uint8_t *pixels = malloc((size_t)WIDTH * 4 * HEIGHT);
    int failures = 0;

    if (!device || !pixels) {
        result = fail("Opening GBM");
        goto done;
    }
    CUresult code = cu.Init(0);
    if (code == 0) code = cu.DeviceGet(&cuda_device, 0);
    if (code == 0) code = cu.CtxCreate(&cuda, 0, cuda_device);
    if (code == 0) code = cu.MemAllocPitch(&frame, &pitch, (size_t)WIDTH * 4, HEIGHT, 16);
    if (cuda) cu.CtxPopCurrent(&ignored);
    if (code != 0) {
        result = cuda_failed(code, "Setting up CUDA");
        goto done;
    }
    result = zuna_importer_open(render_node, cuda, WIDTH, HEIGHT, WIDTH, HEIGHT, &importer);
    if (result >= 0) result = make_current(importer);
    if (result < 0) goto done;

    for (int i = 0; i < count; i++) {
        struct gbm_bo *bo = gbm.bo_create_with_modifiers2(device, WIDTH, HEIGHT, fourcc, &modifiers[i], 1,
                                                          GBM_BO_USE_RENDERING);
        if (!bo) {
            append(report, size, "  0x%016llx: GBM can't make one\n", (unsigned long long)modifiers[i]);
            continue;
        }
        zuna_dmabuf dmabuf = {.fourcc = fourcc, .modifier = gbm.bo_get_modifier(bo), .planes = gbm.bo_get_plane_count(bo)};
        int bo_fd = gbm.bo_get_fd(bo);
        for (int plane = 0; plane < dmabuf.planes && plane < 4; plane++) {
            dmabuf.fd[plane] = bo_fd;
            dmabuf.offset[plane] = gbm.bo_get_offset(bo, plane);
            dmabuf.pitch[plane] = gbm.bo_get_stride_for_plane(bo, plane);
        }

        const char *problem = NULL;
        double took = 0;
        if (fill_quadrants(importer, &dmabuf) < 0) {
            problem = "couldn't draw into it";
        } else {
            double started = now_ms();
            for (int round = 0; round < ROUNDS && !problem; round++) {
                if (zuna_importer_copy(importer, &dmabuf, frame, pitch) < 0) problem = "couldn't copy it into CUDA";
            }
            took = (now_ms() - started) / ROUNDS;
        }
        if (!problem) {
            CUDA_MEMCPY2D back = {
                .srcMemoryType = CU_MEMORYTYPE_DEVICE,
                .srcDevice = frame,
                .srcPitch = pitch,
                .dstMemoryType = CU_MEMORYTYPE_HOST,
                .dstHost = pixels,
                .dstPitch = (size_t)WIDTH * 4,
                .WidthInBytes = (size_t)WIDTH * 4,
                .Height = HEIGHT,
            };
            cu.CtxPushCurrent(cuda);
            code = cu.Memcpy2D(&back);
            cu.CtxPopCurrent(&ignored);
            if (code != 0) problem = "couldn't read it back";
        }
        for (int quadrant = 0; quadrant < 4 && !problem; quadrant++) {
            int x = (quadrant % 2) * WIDTH / 2 + WIDTH / 4, y = (quadrant / 2) * HEIGHT / 2 + HEIGHT / 4;
            const uint8_t *got = pixels + ((size_t)y * WIDTH + x) * 4;
            if (memcmp(got, quadrant_colours[quadrant], 3) != 0) problem = "the wrong colours came out";
        }
        if (problem) failures++;
        append(report, size, "  0x%016llx, %d plane%s: %s", (unsigned long long)dmabuf.modifier, dmabuf.planes,
               dmabuf.planes == 1 ? "" : "s", problem ? problem : "right colours");
        if (!problem) append(report, size, ", %.3f ms a %dx%d frame", took, WIDTH, HEIGHT);
        append(report, size, "\n");
        close(bo_fd);
        gbm.bo_destroy(bo);
    }
    result = failures ? AVERROR_EXTERNAL : 0;

done:
    zuna_importer_close(importer);
    if (frame) {
        cu.CtxPushCurrent(cuda);
        cu.MemFree(frame);
        cu.CtxPopCurrent(&ignored);
    }
    if (cuda) cu.CtxDestroy(cuda);
    if (device) gbm.device_destroy(device);
    free(pixels);
    close(fd);
    return result;
}
