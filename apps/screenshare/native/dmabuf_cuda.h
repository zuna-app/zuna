// DMA-BUFs into CUDA memory, for NVENC, so the compositor's frame never leaves the
// GPU. Neither NVENC nor CUDA takes a DMA-BUF, so EGL brings it into OpenGL, and a
// blit copies it into a texture that CUDA has registered. Sunshine and
// gpu-screen-recorder go the same way.
//
// EGL, OpenGL, CUDA and GBM are all loaded at runtime, so building needs none of them.
#ifndef ZUNA_DMABUF_CUDA_H
#define ZUNA_DMABUF_CUDA_H

#include <stddef.h>
#include <stdint.h>

#include "encoder.h"

typedef struct zuna_importer zuna_importer;

// Takes the CUcontext the frames are in. The OpenGL context it makes is current on
// whichever thread copies first, and has to stay on that thread. Frames come in at the
// source's size and go out at this size.
int zuna_importer_open(const char *render_node, void *cuda_context, int source_width, int source_height, int width,
                       int height, zuna_importer **out);

// Copies a frame into CUDA memory as RGB0, making it smaller if that was asked for, and
// returns once the DMA-BUF can go back to the compositor.
int zuna_importer_copy(zuna_importer *importer, const zuna_dmabuf *dmabuf, uint64_t destination, size_t pitch);

void zuna_importer_close(zuna_importer *importer);

#endif
