// A small C face on libavcodec, so the Rust side needs no generated bindings
// (and so no libclang). encoder.rs declares the same types.
//
// This builds as a shared library of its own, loaded at runtime. LiveKit's static
// libwebrtc holds a private copy of FFmpeg with the same symbol names, and keeping
// ours behind a library boundary is what stops the two from meeting.
#ifndef ZUNA_ENCODER_H
#define ZUNA_ENCODER_H

#include <stdint.h>

#ifdef _WIN32
#define ZUNA_API __declspec(dllexport)
#else
#define ZUNA_API __attribute__((visibility("default")))
#endif

typedef struct zuna_encoder zuna_encoder;

enum zuna_input { ZUNA_INPUT_D3D11 = 0, ZUNA_INPUT_CPU = 1, ZUNA_INPUT_DMABUF = 2 };
enum zuna_pixel { ZUNA_PIXEL_BGRA = 0, ZUNA_PIXEL_RGBA = 1, ZUNA_PIXEL_BGRX = 2, ZUNA_PIXEL_RGBX = 3 };

typedef struct zuna_encoder_config {
    const char *codec;
    int input;
    int pixel;
    int width;
    int height;
    int fps;
    int gop;
    int64_t bitrate;
    void *d3d11_device;       // ID3D11Device*, for ZUNA_INPUT_D3D11
    const char *render_node;  // /dev/dri/renderD128, for VA-API
} zuna_encoder_config;

typedef struct zuna_dmabuf {
    uint32_t fourcc;
    uint64_t modifier;
    int planes;
    int fd[4];
    uint32_t offset[4];
    uint32_t pitch[4];
} zuna_dmabuf;

// All return 0 on success or a negative FFmpeg error, except where noted.
ZUNA_API int zuna_encoder_open(const zuna_encoder_config *config, zuna_encoder **out);
ZUNA_API void zuna_encoder_close(zuna_encoder *encoder);

ZUNA_API int zuna_encoder_send_d3d11(zuna_encoder *encoder, void *texture, int x, int y, int64_t pts, int force_key);
ZUNA_API int zuna_encoder_send_cpu(zuna_encoder *encoder, const uint8_t *data, int stride, int64_t pts, int force_key);
ZUNA_API int zuna_encoder_send_dmabuf(zuna_encoder *encoder, const zuna_dmabuf *dmabuf, int64_t pts, int force_key);

// Encodes the previous input again: for a keyframe request or to refine a still screen.
ZUNA_API int zuna_encoder_repeat(zuna_encoder *encoder, int64_t pts, int force_key);

// Returns 0 with a packet, valid until the next call, or 1 if there's none yet.
ZUNA_API int zuna_encoder_receive(zuna_encoder *encoder, const uint8_t **data, int *size, int64_t *pts, int *key);

// Every encoder answers this with a keyframe, so don't call it for small changes.
ZUNA_API int zuna_encoder_set_bitrate(zuna_encoder *encoder, int64_t bitrate);

ZUNA_API void zuna_encoder_error(int code, char *buffer, int size);

#endif
