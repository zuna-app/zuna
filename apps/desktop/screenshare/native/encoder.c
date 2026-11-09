#include "encoder.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavutil/buffer.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>

#ifdef _WIN32
#define COBJMACROS
#include <d3d11.h>
#include <libavutil/hwcontext_d3d11va.h>
#endif

// ZUNA_CHECK_VAAPI compiles this part anywhere, as a check on the FFmpeg calls.
#if defined(__linux__) || defined(ZUNA_CHECK_VAAPI)
#define ZUNA_VAAPI 1
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/hwcontext_drm.h>
#ifdef __linux__
#include <unistd.h>
#else
#include <io.h>
#endif
#endif

#ifdef __linux__
// FFmpeg's header wants CUDA's for these two, and nothing else from it.
#define CUDA_VERSION 0
typedef struct CUctx_st *CUcontext;
typedef struct CUstream_st *CUstream;
#include <libavutil/hwcontext_cuda.h>

#include "dmabuf_cuda.h"
#endif

struct zuna_encoder {
    char *codec_name;
    zuna_encoder_config config;
    enum AVPixelFormat sw_format;
    AVCodecContext *codec;
    AVPacket *packet;
    AVFrame *last;
    AVBufferRef *device;
    AVBufferRef *frames;
    AVBufferPool *cpu_pool;
    AVBSFContext *tagger;
#ifdef _WIN32
    ID3D11VideoProcessorEnumerator *scaler_enumerator;
    ID3D11VideoProcessor *scaler;
    ID3D11Texture2D *scaler_input;
    ID3D11Texture2D *scaler_output;
    ID3D11VideoProcessorInputView *scaler_input_view;
    ID3D11VideoProcessorOutputView *scaler_output_view;
#endif
#ifdef ZUNA_VAAPI
    AVBufferRef *drm_device;
    AVBufferRef *drm_frames;
    AVFilterGraph *graph;
    AVFilterContext *graph_source;
    AVFilterContext *graph_sink;
    AVFrame *filtered;
#endif
#ifdef __linux__
    zuna_importer *importer;
#endif
};

// Which encoder it is, whatever it encodes: h264_nvenc and av1_nvenc are both "nvenc".
static int is_family(const zuna_encoder *e, const char *family) {
    const char *underscore = strchr(e->codec_name, '_');
    return underscore && strcmp(underscore + 1, family) == 0;
}

static int is_av1(const zuna_encoder *e) {
    return strncmp(e->codec_name, "av1_", 4) == 0;
}

static enum AVPixelFormat sw_format_of(int pixel) {
    switch (pixel) {
    case ZUNA_PIXEL_RGBA: return AV_PIX_FMT_RGBA;
    case ZUNA_PIXEL_BGRX: return AV_PIX_FMT_BGR0;
    case ZUNA_PIXEL_RGBX: return AV_PIX_FMT_RGB0;
    default: return AV_PIX_FMT_BGRA;
    }
}

// The VBV: how far one frame may go over its share. A long one keeps text sharp
// after a scene change, and a short one keeps frames small enough to send at once.
static int vbv_size(int64_t bitrate) {
    int64_t size = bitrate / 4;
    return size > INT32_MAX ? INT32_MAX : (int)size;
}

static int is_scaling(const zuna_encoder *e) {
    return e->config.source_width != e->config.width || e->config.source_height != e->config.height;
}

// Media Foundation's encoders, which is how Windows reaches Intel's and any other GPU's
// own, only take NV12. NVENC and AMF take the capture's BGRA as it is.
static int takes_nv12(const zuna_encoder *e) {
    return is_family(e, "mf");
}

// NVENC's AV1 in CBR spends all of its bitrate whatever the picture, a still screen too,
// where its H.264 sends filler that h264.rs takes out. So AV1 goes in VBR, held to the same
// bitrate at most, which looked better at every bitrate in examples/codec-bench.rs and sent
// a little less. The others' AV1 hasn't run, so it stays as their H.264 is.
static int is_capped_vbr(const zuna_encoder *e) {
    return is_av1(e) && is_family(e, "nvenc");
}

// AV1's options are H.264's where the encoder has the same, and its profile is Main, the
// one there is for 8-bit 4:2:0, which each takes by itself. A forced keyframe has to be a
// KEY_FRAME with its sequence header, rather than an intra frame nobody can start from.
static void set_low_latency_options(zuna_encoder *e) {
    void *options = e->codec->priv_data;
    int quality = e->config.quality;
    int av1 = is_av1(e);
    if (is_family(e, "nvenc")) {
        av_opt_set(options, "preset", quality == ZUNA_QUALITY_SPEED ? "p1" : quality == ZUNA_QUALITY_BEST ? "p7" : "p4", 0);
        av_opt_set(options, "tune", "ull", 0);
        av_opt_set(options, "rc", is_capped_vbr(e) ? "vbr" : "cbr", 0);
        if (!av1) av_opt_set(options, "profile", "high", 0);
        av_opt_set_int(options, "zerolatency", 1, 0);
        av_opt_set_int(options, "delay", 0, 0);
        av_opt_set_int(options, "forced-idr", 1, 0);
        av_opt_set_int(options, "rc-lookahead", 0, 0);
    } else if (is_family(e, "amf")) {
        av_opt_set(options, "usage", "ultralowlatency", 0);
        av_opt_set(options, "quality", quality == ZUNA_QUALITY_SPEED ? "speed" : quality == ZUNA_QUALITY_BEST ? "quality" : "balanced", 0);
        av_opt_set(options, "rc", "cbr", 0);
        av_opt_set_int(options, "forced_idr", 1, 0);
        av_opt_set_int(options, "enforce_hrd", 1, 0);
        av_opt_set_int(options, "filler_data", 0, 0);
        av_opt_set_int(options, "async_depth", 1, 0);
        if (av1) {
            av_opt_set(options, "header_insertion_mode", "gop", 0);
            av_opt_set(options, "latency", "lowest_latency", 0);
            av_opt_set_int(options, "skip_frame", 0, 0);
        } else {
            av_opt_set(options, "profile", "high", 0);
            av_opt_set(options, "header_insertion_mode", "idr", 0);
            av_opt_set_int(options, "latency", 1, 0);
            av_opt_set_int(options, "frame_skipping", 0, 0);
        }
    } else if (is_family(e, "mf")) {
        e->codec->profile = av1 ? AV_PROFILE_AV1_MAIN : AV_PROFILE_H264_HIGH;
        av_opt_set(options, "rate_control", "cbr", 0);
        av_opt_set(options, "scenario", "display_remoting", 0);
        av_opt_set_int(options, "quality", quality == ZUNA_QUALITY_SPEED ? 0 : quality == ZUNA_QUALITY_BEST ? 100 : 50, 0);
        // Media Foundation has encoders in software too, which are what this avoids.
        av_opt_set_int(options, "hw_encoding", 1, 0);
    } else if (is_family(e, "vaapi")) {
        av_opt_set(options, "rc_mode", "CBR", 0);
        av_opt_set_int(options, "async_depth", 1, 0);
        if (!av1) {
            av_opt_set(options, "profile", "high", 0);
            av_opt_set_int(options, "sei", 0, 0);
            av_opt_set_int(options, "aud", 0, 0);
        }
    }
}

static int open_codec(zuna_encoder *e) {
    const AVCodec *codec = avcodec_find_encoder_by_name(e->codec_name);
    if (!codec) return AVERROR_ENCODER_NOT_FOUND;

    avcodec_free_context(&e->codec);
    e->codec = avcodec_alloc_context3(codec);
    if (!e->codec) return AVERROR(ENOMEM);

    AVCodecContext *c = e->codec;
    c->width = e->config.width;
    c->height = e->config.height;
    c->time_base = (AVRational){1, 1000000};
    c->framerate = (AVRational){e->config.fps, 1};
    c->bit_rate = e->config.bitrate;
    c->rc_buffer_size = vbv_size(e->config.bitrate);
    if (is_capped_vbr(e)) c->rc_max_rate = e->config.bitrate;
    c->gop_size = e->config.gop;
    c->max_b_frames = 0;
    c->flags |= AV_CODEC_FLAG_LOW_DELAY;
    c->color_primaries = AVCOL_PRI_BT709;
    c->color_trc = AVCOL_TRC_BT709;
    c->colorspace = AVCOL_SPC_BT709;
    c->color_range = AVCOL_RANGE_MPEG;

    if (e->frames) {
        AVHWFramesContext *frames = (AVHWFramesContext *)e->frames->data;
        c->pix_fmt = frames->format;
        c->sw_pix_fmt = frames->sw_format;
        c->hw_frames_ctx = av_buffer_ref(e->frames);
        if (!c->hw_frames_ctx) return AVERROR(ENOMEM);
    } else {
        c->pix_fmt = e->sw_format;
    }

    set_low_latency_options(e);
    return avcodec_open2(c, codec, NULL);
}

// Media Foundation's encoders say nothing of what colours the stream is in, which leaves
// whoever's watching to guess, so each SPS, or AV1's sequence header, is told what the
// video processor made it.
static int open_tagger(zuna_encoder *e) {
    const AVBitStreamFilter *filter = av_bsf_get_by_name(is_av1(e) ? "av1_metadata" : "h264_metadata");
    if (!filter) return AVERROR_BSF_NOT_FOUND;
    int result = av_bsf_alloc(filter, &e->tagger);
    if (result < 0) return result;
    result = avcodec_parameters_from_context(e->tagger->par_in, e->codec);
    if (result < 0) return result;
    e->tagger->time_base_in = e->codec->time_base;
    void *options = e->tagger->priv_data;
    if (is_av1(e)) {
        av_opt_set_int(options, "color_primaries", AVCOL_PRI_BT709, 0);
        av_opt_set_int(options, "transfer_characteristics", AVCOL_TRC_BT709, 0);
        av_opt_set_int(options, "matrix_coefficients", AVCOL_SPC_BT709, 0);
        av_opt_set(options, "color_range", "tv", 0);
    } else {
        av_opt_set_int(options, "video_format", 5, 0);
        av_opt_set_int(options, "video_full_range_flag", 0, 0);
        av_opt_set_int(options, "colour_primaries", AVCOL_PRI_BT709, 0);
        av_opt_set_int(options, "transfer_characteristics", AVCOL_TRC_BT709, 0);
        av_opt_set_int(options, "matrix_coefficients", AVCOL_SPC_BT709, 0);
    }
    return av_bsf_init(e->tagger);
}

static void mark(AVFrame *frame, int64_t pts, int force_key) {
    frame->pts = pts;
    frame->pict_type = force_key ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    if (force_key) frame->flags |= AV_FRAME_FLAG_KEY;
    else frame->flags &= ~AV_FRAME_FLAG_KEY;
}

// Takes the frame, keeping it as the one to repeat.
static int send_owned(zuna_encoder *e, AVFrame *frame, int64_t pts, int force_key) {
    mark(frame, pts, force_key);
    int result = avcodec_send_frame(e->codec, frame);
    if (result >= 0) {
        av_frame_free(&e->last);
        e->last = frame;
        return 0;
    }
    av_frame_free(&frame);
    return result;
}

#ifdef _WIN32
static int open_d3d11(zuna_encoder *e) {
    e->device = av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA);
    if (!e->device) return AVERROR(ENOMEM);
    AVD3D11VADeviceContext *device = ((AVHWDeviceContext *)e->device->data)->hwctx;
    device->device = (ID3D11Device *)e->config.d3d11_device;
    ID3D11Device_AddRef(device->device);
    int result = av_hwdevice_ctx_init(e->device);
    if (result < 0) return result;

    e->frames = av_hwframe_ctx_alloc(e->device);
    if (!e->frames) return AVERROR(ENOMEM);
    AVHWFramesContext *frames = (AVHWFramesContext *)e->frames->data;
    frames->format = AV_PIX_FMT_D3D11;
    frames->sw_format = takes_nv12(e) ? AV_PIX_FMT_NV12 : e->sw_format;
    frames->width = e->config.width;
    frames->height = e->config.height;
    // No initial size: textures that bind as render targets can't be an array.
    frames->initial_pool_size = 0;
    ((AVD3D11VAFramesContext *)frames->hwctx)->BindFlags = D3D11_BIND_RENDER_TARGET;
    return av_hwframe_ctx_init(e->frames);
}

static ID3D11Texture2D *scaler_texture(ID3D11Device *device, int width, int height, DXGI_FORMAT format, UINT bind_flags) {
    D3D11_TEXTURE2D_DESC desc = {
        .Width = (UINT)width,
        .Height = (UINT)height,
        .MipLevels = 1,
        .ArraySize = 1,
        .Format = format,
        .SampleDesc = {.Count = 1},
        .Usage = D3D11_USAGE_DEFAULT,
        .BindFlags = bind_flags,
    };
    ID3D11Texture2D *texture = NULL;
    return SUCCEEDED(ID3D11Device_CreateTexture2D(device, &desc, NULL, &texture)) ? texture : NULL;
}

// Windows's video processor, which every GPU with an encoder has, makes the picture
// smaller, and NV12 for an encoder that needs it, without it leaving the GPU. A frame goes
// through two textures of its own, so neither its views nor the processor's filters have
// to do with what the capture hands over.
static int open_scaler(zuna_encoder *e) {
    AVD3D11VADeviceContext *device = ((AVHWDeviceContext *)e->device->data)->hwctx;
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content = {
        .InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        .InputFrameRate = {(UINT)e->config.fps, 1},
        .InputWidth = (UINT)e->config.source_width,
        .InputHeight = (UINT)e->config.source_height,
        .OutputFrameRate = {(UINT)e->config.fps, 1},
        .OutputWidth = (UINT)e->config.width,
        .OutputHeight = (UINT)e->config.height,
        .Usage = D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
    };
    if (FAILED(ID3D11VideoDevice_CreateVideoProcessorEnumerator(device->video_device, &content, &e->scaler_enumerator)) ||
        FAILED(ID3D11VideoDevice_CreateVideoProcessor(device->video_device, e->scaler_enumerator, 0, &e->scaler)))
        return AVERROR_EXTERNAL;

    e->scaler_input = scaler_texture(device->device, e->config.source_width, e->config.source_height, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE);
    e->scaler_output = scaler_texture(device->device, e->config.width, e->config.height, takes_nv12(e) ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET);
    if (!e->scaler_input || !e->scaler_output) return AVERROR_EXTERNAL;

    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input = {.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D};
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output = {.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D};
    if (FAILED(ID3D11VideoDevice_CreateVideoProcessorInputView(device->video_device, (ID3D11Resource *)e->scaler_input, e->scaler_enumerator, &input, &e->scaler_input_view)) ||
        FAILED(ID3D11VideoDevice_CreateVideoProcessorOutputView(device->video_device, (ID3D11Resource *)e->scaler_output, e->scaler_enumerator, &output, &e->scaler_output_view)))
        return AVERROR_EXTERNAL;

    // RGB in at full range, with none of what the driver would do for video on its own, and
    // out as it came or as BT.709 at studio range, which is what the stream says it is.
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE color = {.Usage = 0, .RGB_Range = 0, .YCbCr_Matrix = 1, .Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255};
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE yuv = {.Usage = 0, .RGB_Range = 0, .YCbCr_Matrix = 1, .Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235};
    device->lock(device->lock_ctx);
    ID3D11VideoContext_VideoProcessorSetStreamFrameFormat(device->video_context, e->scaler, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    ID3D11VideoContext_VideoProcessorSetStreamColorSpace(device->video_context, e->scaler, 0, &color);
    ID3D11VideoContext_VideoProcessorSetOutputColorSpace(device->video_context, e->scaler, takes_nv12(e) ? &yuv : &color);
    ID3D11VideoContext_VideoProcessorSetStreamAutoProcessingMode(device->video_context, e->scaler, 0, FALSE);
    device->unlock(device->lock_ctx);
    return 0;
}

static void close_scaler(zuna_encoder *e) {
    if (e->scaler_output_view) ID3D11VideoProcessorOutputView_Release(e->scaler_output_view);
    if (e->scaler_input_view) ID3D11VideoProcessorInputView_Release(e->scaler_input_view);
    if (e->scaler_output) ID3D11Texture2D_Release(e->scaler_output);
    if (e->scaler_input) ID3D11Texture2D_Release(e->scaler_input);
    if (e->scaler) ID3D11VideoProcessor_Release(e->scaler);
    if (e->scaler_enumerator) ID3D11VideoProcessorEnumerator_Release(e->scaler_enumerator);
}
#endif

int zuna_encoder_send_d3d11(zuna_encoder *e, void *texture, int x, int y, int64_t pts, int force_key) {
#ifdef _WIN32
    AVFrame *frame = av_frame_alloc();
    if (!frame) return AVERROR(ENOMEM);
    int result = av_hwframe_get_buffer(e->frames, frame, 0);
    if (result < 0) {
        av_frame_free(&frame);
        return result;
    }

    AVD3D11VADeviceContext *device = ((AVHWDeviceContext *)e->device->data)->hwctx;
    D3D11_BOX box = {(UINT)x, (UINT)y, 0, (UINT)(x + e->config.source_width), (UINT)(y + e->config.source_height), 1};
    device->lock(device->lock_ctx);
    if (e->scaler) {
        ID3D11DeviceContext_CopySubresourceRegion(device->device_context, (ID3D11Resource *)e->scaler_input, 0, 0, 0, 0, (ID3D11Resource *)texture, 0, &box);
        D3D11_VIDEO_PROCESSOR_STREAM stream = {.Enable = TRUE, .pInputSurface = e->scaler_input_view};
        if (FAILED(ID3D11VideoContext_VideoProcessorBlt(device->video_context, e->scaler, e->scaler_output_view, 0, 1, &stream))) result = AVERROR_EXTERNAL;
        ID3D11DeviceContext_CopySubresourceRegion(device->device_context, (ID3D11Resource *)frame->data[0],
                                                  (UINT)(intptr_t)frame->data[1], 0, 0, 0, (ID3D11Resource *)e->scaler_output, 0, NULL);
    } else {
        ID3D11DeviceContext_CopySubresourceRegion(device->device_context, (ID3D11Resource *)frame->data[0],
                                                  (UINT)(intptr_t)frame->data[1], 0, 0, 0, (ID3D11Resource *)texture, 0,
                                                  &box);
    }
    ID3D11DeviceContext_Flush(device->device_context);
    device->unlock(device->lock_ctx);
    if (result < 0) {
        av_frame_free(&frame);
        return result;
    }

    return send_owned(e, frame, pts, force_key);
#else
    (void)e, (void)texture, (void)x, (void)y, (void)pts, (void)force_key;
    return AVERROR(ENOSYS);
#endif
}

static AVFrame *copy_cpu_frame(zuna_encoder *e, const uint8_t *data, int stride) {
    int width = e->config.source_width * 4;
    AVFrame *frame = av_frame_alloc();
    if (!frame) return NULL;
    frame->buf[0] = av_buffer_pool_get(e->cpu_pool);
    if (!frame->buf[0]) {
        av_frame_free(&frame);
        return NULL;
    }
    frame->format = e->sw_format;
    frame->width = e->config.source_width;
    frame->height = e->config.source_height;
    frame->data[0] = frame->buf[0]->data;
    frame->linesize[0] = width;
    for (int row = 0; row < e->config.source_height; row++)
        memcpy(frame->data[0] + row * width, data + row * stride, width);
    return frame;
}

#ifdef ZUNA_VAAPI
static void free_drm_descriptor(void *opaque, uint8_t *data) {
    (void)opaque;
    av_free(data);
}

static int open_vaapi_devices(zuna_encoder *e) {
    int result = av_hwdevice_ctx_create(&e->device, AV_HWDEVICE_TYPE_VAAPI, e->config.render_node, NULL, 0);
    if (result < 0 || e->config.input != ZUNA_INPUT_DMABUF) return result;

    result = av_hwdevice_ctx_create(&e->drm_device, AV_HWDEVICE_TYPE_DRM, e->config.render_node, NULL, 0);
    if (result < 0) return result;
    e->drm_frames = av_hwframe_ctx_alloc(e->drm_device);
    if (!e->drm_frames) return AVERROR(ENOMEM);
    AVHWFramesContext *frames = (AVHWFramesContext *)e->drm_frames->data;
    frames->format = AV_PIX_FMT_DRM_PRIME;
    frames->sw_format = e->sw_format;
    frames->width = e->config.source_width;
    frames->height = e->config.source_height;
    return av_hwframe_ctx_init(e->drm_frames);
}

// Colour conversion on the GPU, since VA-API encoders take only NV12, and any change of
// size along with it: a DMA-BUF maps straight onto a VA surface, and CPU memory has to
// upload first.
static int open_graph(zuna_encoder *e) {
    int dmabuf = e->config.input == ZUNA_INPUT_DMABUF;
    e->graph = avfilter_graph_alloc();
    if (!e->graph) return AVERROR(ENOMEM);

    char source_args[160];
    snprintf(source_args, sizeof source_args, "video_size=%dx%d:pix_fmt=%d:time_base=1/1000000:pixel_aspect=1/1",
             e->config.source_width, e->config.source_height, dmabuf ? AV_PIX_FMT_DRM_PRIME : e->sw_format);
    int result = avfilter_graph_create_filter(&e->graph_source, avfilter_get_by_name("buffer"), "in", source_args,
                                              NULL, e->graph);
    if (result < 0) return result;
    result = avfilter_graph_create_filter(&e->graph_sink, avfilter_get_by_name("buffersink"), "out", NULL, NULL,
                                          e->graph);
    if (result < 0) return result;

    if (dmabuf) {
        AVBufferSrcParameters *parameters = av_buffersrc_parameters_alloc();
        if (!parameters) return AVERROR(ENOMEM);
        parameters->hw_frames_ctx = e->drm_frames;
        result = av_buffersrc_parameters_set(e->graph_source, parameters);
        av_free(parameters);
        if (result < 0) return result;
    }

    AVFilterInOut *outputs = avfilter_inout_alloc();
    AVFilterInOut *inputs = avfilter_inout_alloc();
    if (!outputs || !inputs) {
        avfilter_inout_free(&outputs);
        avfilter_inout_free(&inputs);
        return AVERROR(ENOMEM);
    }
    outputs->name = av_strdup("in");
    outputs->filter_ctx = e->graph_source;
    inputs->name = av_strdup("out");
    inputs->filter_ctx = e->graph_sink;

    char description[160];
    snprintf(description, sizeof description, "%s,scale_vaapi=w=%d:h=%d:format=nv12:out_color_matrix=bt709:out_range=tv",
             dmabuf ? "hwmap=derive_device=vaapi" : "hwupload", e->config.width, e->config.height);
    result = avfilter_graph_parse_ptr(e->graph, description, &inputs, &outputs, NULL);
    avfilter_inout_free(&outputs);
    avfilter_inout_free(&inputs);
    if (result < 0) return result;

    for (unsigned i = 0; i < e->graph->nb_filters; i++) {
        AVFilterContext *filter = e->graph->filters[i];
        if (filter != e->graph_source && filter != e->graph_sink && !dmabuf) {
            filter->hw_device_ctx = av_buffer_ref(e->device);
            if (!filter->hw_device_ctx) return AVERROR(ENOMEM);
        }
    }
    result = avfilter_graph_config(e->graph, NULL);
    if (result < 0) return result;

    e->frames = av_buffer_ref(av_buffersink_get_hw_frames_ctx(e->graph_sink));
    return e->frames ? 0 : AVERROR(EINVAL);
}

// A filtered frame is an NV12 surface of its own, so it can be repeated after the
// capture buffer has gone back to the compositor.
static int send_through_graph(zuna_encoder *e, AVFrame *frame, int64_t pts, int force_key) {
    frame->pts = pts;
    int result = av_buffersrc_add_frame_flags(e->graph_source, frame, 0);
    av_frame_free(&frame);
    if (result < 0) return result;

    AVFrame *filtered = av_frame_alloc();
    if (!filtered) return AVERROR(ENOMEM);
    result = av_buffersink_get_frame(e->graph_sink, filtered);
    if (result < 0) {
        av_frame_free(&filtered);
        return result;
    }
    return send_owned(e, filtered, pts, force_key);
}
#endif

int zuna_encoder_send_cpu(zuna_encoder *e, const uint8_t *data, int stride, int64_t pts, int force_key) {
    AVFrame *frame = copy_cpu_frame(e, data, stride);
    if (!frame) return AVERROR(ENOMEM);
#ifdef ZUNA_VAAPI
    if (e->graph) return send_through_graph(e, frame, pts, force_key);
#endif
    return send_owned(e, frame, pts, force_key);
}

#ifdef __linux__
// NVENC from DMA-BUFs: the importer copies each frame into CUDA memory on the GPU.
static int open_cuda(zuna_encoder *e) {
    int result = av_hwdevice_ctx_create(&e->device, AV_HWDEVICE_TYPE_CUDA, NULL, NULL, 0);
    if (result < 0) return result;
    e->frames = av_hwframe_ctx_alloc(e->device);
    if (!e->frames) return AVERROR(ENOMEM);
    AVHWFramesContext *frames = (AVHWFramesContext *)e->frames->data;
    frames->format = AV_PIX_FMT_CUDA;
    frames->sw_format = AV_PIX_FMT_RGB0;
    frames->width = e->config.width;
    frames->height = e->config.height;
    result = av_hwframe_ctx_init(e->frames);
    if (result < 0) return result;
    AVCUDADeviceContext *device = ((AVHWDeviceContext *)e->device->data)->hwctx;
    return zuna_importer_open(e->config.render_node, device->cuda_ctx, e->config.source_width, e->config.source_height,
                              e->config.width, e->config.height, &e->importer);
}

// A frame of its own in CUDA memory, so it can be repeated after the capture buffer
// has gone back to the compositor.
static int send_through_cuda(zuna_encoder *e, const zuna_dmabuf *dmabuf, int64_t pts, int force_key) {
    AVFrame *frame = av_frame_alloc();
    if (!frame) return AVERROR(ENOMEM);
    int result = av_hwframe_get_buffer(e->frames, frame, 0);
    if (result >= 0)
        result = zuna_importer_copy(e->importer, dmabuf, (uint64_t)(uintptr_t)frame->data[0], frame->linesize[0]);
    if (result < 0) {
        av_frame_free(&frame);
        return result;
    }
    return send_owned(e, frame, pts, force_key);
}
#endif

int zuna_encoder_send_dmabuf(zuna_encoder *e, const zuna_dmabuf *dmabuf, int64_t pts, int force_key) {
#ifdef __linux__
    if (e->importer) return send_through_cuda(e, dmabuf, pts, force_key);
#endif
#ifdef ZUNA_VAAPI
    AVDRMFrameDescriptor *descriptor = av_mallocz(sizeof *descriptor);
    if (!descriptor) return AVERROR(ENOMEM);
    descriptor->nb_objects = dmabuf->planes;
    descriptor->nb_layers = 1;
    descriptor->layers[0].format = dmabuf->fourcc;
    descriptor->layers[0].nb_planes = dmabuf->planes;
    for (int i = 0; i < dmabuf->planes; i++) {
        descriptor->objects[i].fd = dmabuf->fd[i];
        descriptor->objects[i].size = lseek(dmabuf->fd[i], 0, SEEK_END);
        descriptor->objects[i].format_modifier = dmabuf->modifier;
        descriptor->layers[0].planes[i].object_index = i;
        descriptor->layers[0].planes[i].offset = dmabuf->offset[i];
        descriptor->layers[0].planes[i].pitch = dmabuf->pitch[i];
    }

    AVFrame *frame = av_frame_alloc();
    if (!frame) {
        av_free(descriptor);
        return AVERROR(ENOMEM);
    }
    frame->format = AV_PIX_FMT_DRM_PRIME;
    frame->width = e->config.source_width;
    frame->height = e->config.source_height;
    frame->data[0] = (uint8_t *)descriptor;
    frame->buf[0] = av_buffer_create((uint8_t *)descriptor, sizeof *descriptor, free_drm_descriptor, NULL, 0);
    frame->hw_frames_ctx = av_buffer_ref(e->drm_frames);
    if (!frame->buf[0] || !frame->hw_frames_ctx) {
        av_frame_free(&frame);
        return AVERROR(ENOMEM);
    }
    return send_through_graph(e, frame, pts, force_key);
#else
    (void)e, (void)dmabuf, (void)pts, (void)force_key;
    return AVERROR(ENOSYS);
#endif
}

int zuna_encoder_repeat(zuna_encoder *e, int64_t pts, int force_key) {
    if (!e->last) return 0;
    AVFrame *frame = av_frame_clone(e->last);
    if (!frame) return AVERROR(ENOMEM);
    return send_owned(e, frame, pts, force_key);
}

int zuna_encoder_receive(zuna_encoder *e, const uint8_t **data, int *size, int64_t *pts, int *key) {
    av_packet_unref(e->packet);
    int result = avcodec_receive_packet(e->codec, e->packet);
    if (result == AVERROR(EAGAIN)) return 1;
    if (result < 0) return result;
    // One packet in and the same one out, as the filter only rewrites SPSs.
    if (e->tagger) {
        result = av_bsf_send_packet(e->tagger, e->packet);
        if (result >= 0) result = av_bsf_receive_packet(e->tagger, e->packet);
        if (result < 0) return result;
    }
    *data = e->packet->data;
    *size = e->packet->size;
    *pts = e->packet->pts;
    *key = (e->packet->flags & AV_PKT_FLAG_KEY) != 0;
    return 0;
}

int zuna_encoder_set_bitrate(zuna_encoder *e, int64_t bitrate) {
    e->config.bitrate = bitrate;
    // NVENC reconfigures itself on its next frame, with a keyframe. The others take
    // their bitrate only when opened.
    if (is_family(e, "nvenc")) {
        e->codec->bit_rate = bitrate;
        e->codec->rc_buffer_size = vbv_size(bitrate);
        if (is_capped_vbr(e)) e->codec->rc_max_rate = bitrate;
        return 0;
    }
    return open_codec(e);
}

int zuna_encoder_open(const zuna_encoder_config *config, zuna_encoder **out) {
    zuna_encoder *e = calloc(1, sizeof *e);
    if (!e) return AVERROR(ENOMEM);
    e->config = *config;
    e->codec_name = av_strdup(config->codec);
    e->sw_format = sw_format_of(config->pixel);
    e->packet = av_packet_alloc();
    int result = e->codec_name && e->packet ? 0 : AVERROR(ENOMEM);

    if (result >= 0 && config->input != ZUNA_INPUT_D3D11 && config->input != ZUNA_INPUT_DMABUF) {
        e->cpu_pool = av_buffer_pool_init(config->source_width * 4 * config->source_height, NULL);
        if (!e->cpu_pool) result = AVERROR(ENOMEM);
    }
#ifdef _WIN32
    if (result >= 0 && config->input == ZUNA_INPUT_D3D11) result = open_d3d11(e);
    if (result >= 0 && config->input == ZUNA_INPUT_D3D11 && (is_scaling(e) || takes_nv12(e))) result = open_scaler(e);
#endif
#ifdef ZUNA_VAAPI
    if (result >= 0 && is_family(e, "vaapi")) {
        result = open_vaapi_devices(e);
        if (result >= 0) result = open_graph(e);
    }
#endif
#ifdef __linux__
    if (result >= 0 && is_family(e, "nvenc") && config->input == ZUNA_INPUT_DMABUF) result = open_cuda(e);
#endif
    if (result >= 0) result = open_codec(e);
    if (result >= 0 && is_family(e, "mf")) result = open_tagger(e);
    if (result < 0) {
        zuna_encoder_close(e);
        return result;
    }
    *out = e;
    return 0;
}

void zuna_encoder_close(zuna_encoder *e) {
    if (!e) return;
    av_frame_free(&e->last);
    av_bsf_free(&e->tagger);
    avcodec_free_context(&e->codec);
#ifdef _WIN32
    close_scaler(e);
#endif
#ifdef __linux__
    zuna_importer_close(e->importer);
#endif
#ifdef ZUNA_VAAPI
    avfilter_graph_free(&e->graph);
    av_buffer_unref(&e->drm_frames);
    av_buffer_unref(&e->drm_device);
#endif
    av_buffer_unref(&e->frames);
    av_buffer_unref(&e->device);
    av_buffer_pool_uninit(&e->cpu_pool);
    av_packet_free(&e->packet);
    av_free(e->codec_name);
    free(e);
}

void zuna_encoder_error(int code, char *buffer, int size) {
    av_strerror(code, buffer, size);
}
