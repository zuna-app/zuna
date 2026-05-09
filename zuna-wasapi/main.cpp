/**
 * zuna-wasapi - WASAPI ApplicationLoopback per-process audio capture
 * Licensed under AGPL v3.0 - see LICENSE.txt
 * Author: SocketByte (poczta.xvacuum@gmail.com) exclusively for Zuna
 *
 * Usage:  zuna-wasapi.exe <target_pid>
 *
 * Opens a named-pipe server at  \\.\pipe\zuna-wasapi-<pid>
 * and streams raw PCM frames to the first connecting client.
 *
 * Wire format:
 *   [DWORD  wfxSize ]  - total byte count of the WAVEFORMATEX block that follows
 *   [BYTE[] wfxData ]  - WAVEFORMATEX (+ optional cbSize extension bytes)
 *   [BYTE[] pcm     ]  - endless stream of raw, interleaved PCM frames
 *
 * Requirements: Windows 10 20H1 (build 19041) or later.
 * Compiler    : MinGW-w64 (GCC / C++20) - no WRL/MSVC headers required.
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>   // IAudioClient, IAudioCaptureClient, AUDCLNT_* flags
#include <audiopolicy.h>
#include <avrt.h>
#include <cstdio>
#include <iostream>
#include <string>
#include <atomic>
#include <stdexcept>
#include <vector>
#include <cstring>
#include "com.h"

static std::atomic<bool> g_running{ true };

static void ThrowIfFailed(HRESULT hr, const char* ctx = "")
{
    if (FAILED(hr)) {
        char buf[128];
        std::snprintf(buf, sizeof(buf), "%s  [HRESULT 0x%08X]", ctx, static_cast<unsigned>(hr));
        throw std::runtime_error(buf);
    }
}

static void WriteExact(HANDLE hPipe, const void* data, DWORD bytes)
{
    const auto* ptr = static_cast<const BYTE*>(data);
    while (bytes > 0) {
        DWORD written = 0;
        if (!WriteFile(hPipe, ptr, bytes, &written, nullptr) || written == 0)
            throw std::runtime_error("WriteFile failed — client disconnected?");
        ptr   += written;
        bytes -= written;
    }
}

int main(int argc, char* argv[])
{
    if (argc < 2) {
        std::cerr <<
            "Usage: zuna-wasapi.exe <target_pid>\n\n"
            "  Captures audio from <target_pid> via WASAPI ApplicationLoopback\n"
            "  and streams raw PCM over a named pipe:\n"
            "    \\\\.\\pipe\\zuna-wasapi-<pid>\n\n"
            "  Wire format sent to the pipe:\n"
            "    [DWORD wfxSize] [WAVEFORMATEX(+ext) bytes] [raw PCM stream...]\n\n"
            "  Requires Windows 10 20H1 (build 19041) or later.\n";
        return 1;
    }

    DWORD targetPid = 0;
    try { targetPid = static_cast<DWORD>(std::stoul(argv[1])); }
    catch (...) { std::cerr << "Invalid PID: " << argv[1] << "\n"; return 1; }

    SetConsoleCtrlHandler([](DWORD sig) -> BOOL {
        if (sig == CTRL_C_EVENT || sig == CTRL_BREAK_EVENT) {
            g_running = false;
            return TRUE;
        }
        return FALSE;
    }, TRUE);

    HMODULE hMmdevapi = LoadLibraryW(L"mmdevapi.dll");
    if (!hMmdevapi) {
        std::cerr << "LoadLibrary(mmdevapi.dll) failed: " << GetLastError() << "\n";
        return 1;
    }
    auto fnActivate = reinterpret_cast<PFN_ActivateAudioInterfaceAsync>(
        GetProcAddress(hMmdevapi, "ActivateAudioInterfaceAsync"));
    if (!fnActivate) {
        std::cerr << "ActivateAudioInterfaceAsync not found in mmdevapi.dll\n"
                     "(Requires Windows 10 20H1 or later)\n";
        FreeLibrary(hMmdevapi);
        return 1;
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ThrowIfFailed(hr, "CoInitializeEx");

    int exitCode = 0;
    try {
        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId   = targetPid;
        params.ProcessLoopbackParams.ProcessLoopbackMode =
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

        PROPVARIANT pv{};
        pv.vt             = VT_BLOB;
        pv.blob.cbSize    = sizeof(params);
        pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

        ActivationCtx actCtx;
        actCtx.hEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!actCtx.hEvent) throw std::runtime_error("CreateEvent failed");

        auto* pHandler = new ActivationHandler(&actCtx);   // ref count = 1

        IActivateAudioInterfaceAsyncOperation* pAsyncOp = nullptr;
        hr = fnActivate(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            IID_IAudioClient,
            &pv,
            pHandler,
            &pAsyncOp);
        ThrowIfFailed(hr, "ActivateAudioInterfaceAsync");

        WaitForSingleObject(actCtx.hEvent, INFINITE);
        CloseHandle(actCtx.hEvent);

        pHandler->Release();
        if (pAsyncOp) pAsyncOp->Release();

        ThrowIfFailed(actCtx.hr, "Audio client activation");

        IAudioClient* pAudioClient = actCtx.pAudioClient;
        WAVEFORMATEX* pwfx = nullptr;
        {
            IMMDeviceEnumerator* pEnum = nullptr;
            hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, IID_IMMDeviceEnumerator,
                                  reinterpret_cast<void**>(&pEnum));
            ThrowIfFailed(hr, "CoCreateInstance(MMDeviceEnumerator)");

            IMMDevice* pDevice = nullptr;
            hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
            pEnum->Release();
            ThrowIfFailed(hr, "GetDefaultAudioEndpoint");

            IAudioClient* pTmp = nullptr;
            hr = pDevice->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr,
                                   reinterpret_cast<void**>(&pTmp));
            pDevice->Release();
            ThrowIfFailed(hr, "Activate(temp client for GetMixFormat)");

            hr = pTmp->GetMixFormat(&pwfx);
            pTmp->Release();
            ThrowIfFailed(hr, "GetMixFormat");
        }

        std::cout << "Audio format:\n"
                  << "  Channels   : " << pwfx->nChannels      << "\n"
                  << "  Sample rate: " << pwfx->nSamplesPerSec << " Hz\n"
                  << "  Bits/sample: " << pwfx->wBitsPerSample << "\n"
                  << "  Block align: " << pwfx->nBlockAlign     << " bytes\n"
                  << "  Format tag : 0x" << std::hex << pwfx->wFormatTag
                                         << std::dec                      << "\n"
                  << "  cbSize     : " << pwfx->cbSize          << "\n\n";

        HANDLE hAudioReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!hAudioReady) throw std::runtime_error("CreateEvent(audio) failed");

        const REFERENCE_TIME kBufDuration = 2'000'000; // 200 ms in hns

        hr = pAudioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            kBufDuration,
            0,
            pwfx,
            nullptr);
        ThrowIfFailed(hr, "IAudioClient::Initialize");

        hr = pAudioClient->SetEventHandle(hAudioReady);
        ThrowIfFailed(hr, "SetEventHandle");

        IAudioCaptureClient* pCapture = nullptr;
        hr = pAudioClient->GetService(IID_PPV_ARGS(&pCapture));
        ThrowIfFailed(hr, "GetService(IAudioCaptureClient)");

        std::wstring pipeName = L"\\\\.\\pipe\\zuna-wasapi-" + std::to_wstring(targetPid);

        HANDLE hPipe = CreateNamedPipeW(
            pipeName.c_str(),
            PIPE_ACCESS_OUTBOUND,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,          // max instances
            1 << 20,    // out buffer 1 MiB
            0,          // in buffer (write-only pipe)
            0,          // default timeout
            nullptr);

        if (hPipe == INVALID_HANDLE_VALUE)
            throw std::runtime_error("CreateNamedPipeW failed: " +
                                     std::to_string(GetLastError()));

        if (!ConnectNamedPipe(hPipe, nullptr)) {
            DWORD err = GetLastError();
            if (err != ERROR_PIPE_CONNECTED) {
                CloseHandle(hPipe);
                throw std::runtime_error("ConnectNamedPipe failed: " +
                                         std::to_string(err));
            }
        }

        DWORD wfxBytes = sizeof(WAVEFORMATEX) + pwfx->cbSize;
        WriteExact(hPipe, &wfxBytes, sizeof(wfxBytes));
        WriteExact(hPipe, pwfx,      wfxBytes);

        DWORD taskIdx  = 0;
        HANDLE hMmcss  = AvSetMmThreadCharacteristicsW(L"Audio", &taskIdx);

        hr = pAudioClient->Start();
        ThrowIfFailed(hr, "IAudioClient::Start");

        std::vector<BYTE> silenceBuf; // re-used for AUDCLNT_BUFFERFLAGS_SILENT

        while (g_running) {
            DWORD wait = WaitForSingleObject(hAudioReady, 200);
            if (wait == WAIT_TIMEOUT)   continue;
            if (wait != WAIT_OBJECT_0)  break;

            UINT32 packetFrames = 0;
            if (FAILED(pCapture->GetNextPacketSize(&packetFrames))) break;

            while (packetFrames > 0 && g_running) {
                BYTE*  pData  = nullptr;
                UINT32 frames = 0;
                DWORD  flags  = 0;

                hr = pCapture->GetBuffer(&pData, &frames, &flags, nullptr, nullptr);
                if (FAILED(hr)) { g_running = false; break; }

                DWORD bytesToSend = frames * pwfx->nBlockAlign;
                try {
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        if (silenceBuf.size() < bytesToSend)
                            silenceBuf.assign(bytesToSend, 0);
                        WriteExact(hPipe, silenceBuf.data(), bytesToSend);
                    } else {
                        WriteExact(hPipe, pData, bytesToSend);
                    }
                } catch (const std::runtime_error& e) {
                    pCapture->ReleaseBuffer(frames);
                    std::cerr << "\n" << e.what() << "\n";
                    g_running = false;
                    break;
                }

                pCapture->ReleaseBuffer(frames);

                if (FAILED(pCapture->GetNextPacketSize(&packetFrames))) {
                    g_running = false;
                    break;
                }
            }
        }

        pAudioClient->Stop();
        if (hMmcss) AvRevertMmThreadCharacteristics(hMmcss);

        FlushFileBuffers(hPipe);
        DisconnectNamedPipe(hPipe);
        CloseHandle(hPipe);
        CloseHandle(hAudioReady);
        CoTaskMemFree(pwfx);
        pCapture->Release();
        pAudioClient->Release();
    }
    catch (const std::exception& e) {
        std::cerr << "Fatal error: " << e.what() << "\n";
        exitCode = 1;
    }

    CoUninitialize();
    FreeLibrary(hMmdevapi);
    return exitCode;
}
