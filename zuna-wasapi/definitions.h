#ifndef DEFINITIONS_H
#define DEFINITIONS_H

#include <windows.h>

enum AUDIOCLIENT_ACTIVATION_TYPE {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT          = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
};

enum PROCESS_LOOPBACK_MODE {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
};

struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD               TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
};

struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
};

#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"

#ifndef __IActivateAudioInterfaceAsyncOperation_INTERFACE_DEFINED__
#define __IActivateAudioInterfaceAsyncOperation_INTERFACE_DEFINED__
struct IActivateAudioInterfaceAsyncOperation : public IUnknown
{
    virtual HRESULT STDMETHODCALLTYPE GetActivateResult(
        HRESULT* activateResult,
        IUnknown** activatedInterface) = 0;
};
#endif // __IActivateAudioInterfaceAsyncOperation_INTERFACE_DEFINED__

#ifndef __IActivateAudioInterfaceCompletionHandler_INTERFACE_DEFINED__
#define __IActivateAudioInterfaceCompletionHandler_INTERFACE_DEFINED__
struct IActivateAudioInterfaceCompletionHandler : public IUnknown
{
    virtual HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* activateOperation) = 0;
};
#endif // __IActivateAudioInterfaceCompletionHandler_INTERFACE_DEFINED__

static const GUID IID_IActivateAudioInterfaceCompletionHandler_ =
    {0x41D949AB,0x9862,0x444A,{0x80,0xF6,0xC2,0x61,0x33,0x4D,0xA5,0xEB}};

#ifndef __IAgileObject_INTERFACE_DEFINED__
#define __IAgileObject_INTERFACE_DEFINED__
struct IAgileObject : public IUnknown {};
#endif
static const GUID IID_IAgileObject_ =
    {0x94EA2B94,0xE9CC,0x49E0,{0xC0,0xFF,0xEE,0x64,0xCA,0x8F,0x5B,0x90}};

typedef HRESULT (WINAPI *PFN_ActivateAudioInterfaceAsync)(
    LPCWSTR                                   deviceInterfacePath,
    REFIID                                    riid,
    PROPVARIANT*                              activationParams,
    IActivateAudioInterfaceCompletionHandler* completionHandler,
    IActivateAudioInterfaceAsyncOperation**   activationOperation);


#endif // DEFINITIONS_H