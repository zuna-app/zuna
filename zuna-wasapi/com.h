#ifndef COM_H
#define COM_H

#include <windows.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include "definitions.h"

struct ActivationCtx {
    HANDLE        hEvent       = nullptr;
    IAudioClient* pAudioClient = nullptr;
    HRESULT       hr           = E_PENDING;
};

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler,
                                public IAgileObject
{
    volatile LONG  m_refCount = 1;
    ActivationCtx* m_ctx;

public:
    explicit ActivationHandler(ActivationCtx* ctx) : m_ctx(ctx) {}

    ULONG STDMETHODCALLTYPE AddRef() noexcept override {
        return InterlockedIncrement(&m_refCount);
    }
    ULONG STDMETHODCALLTYPE Release() noexcept override {
        ULONG n = InterlockedDecrement(&m_refCount);
        if (n == 0) delete this;
        return n;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) noexcept override {
        if (riid == IID_IUnknown ||
            riid == IID_IActivateAudioInterfaceCompletionHandler_)
        {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        if (riid == IID_IAgileObject_) {
            *ppv = static_cast<IAgileObject*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* op) noexcept override
    {
        HRESULT hrActivate = E_UNEXPECTED;
        IUnknown* pUnk = nullptr;
        HRESULT hr = op->GetActivateResult(&hrActivate, &pUnk);
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && pUnk) {
            hr = pUnk->QueryInterface(IID_IAudioClient,
                                     reinterpret_cast<void**>(&m_ctx->pAudioClient));
            m_ctx->hr = hr;
            pUnk->Release();
        } else {
            m_ctx->hr = FAILED(hr) ? hr : hrActivate;
        }
        SetEvent(m_ctx->hEvent);
        return S_OK;
    }
};

#endif // COM_H