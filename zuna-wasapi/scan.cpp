/**
 * zuna-wasapi-scan - enumerate running windowed processes (potential audio sources)
 * Licensed under AGPL v3.0 - see LICENSE.txt
 * Author: SocketByte (poczta.xvacuum@gmail.com) exclusively for Zuna
 *
 * Usage:  zuna-wasapi-scan.exe
 *
 *   Prints a JSON array to stdout.  Each element is { "name": "...", "pid": N }.
 *   Lists all processes with a visible top-level window - i.e. every user-facing
 *   app that could potentially play audio, regardless of whether it has started
 *   an audio session yet.
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <psapi.h>

#include <cstdio>
#include <string>
#include <vector>
#include <set>

#pragma comment(lib, "psapi.lib")

static std::string WideToUtf8(const wchar_t* w)
{
    if (!w || !*w) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string s(n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}

static std::string GetProcessName(DWORD pid)
{
    if (pid == 0) return "System Sounds";

    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc) return "unknown";

    wchar_t buf[MAX_PATH] = {};
    DWORD len = MAX_PATH;
    std::string name;

    if (QueryFullProcessImageNameW(hProc, 0, buf, &len)) {
        wchar_t* slash = wcsrchr(buf, L'\\');
        name = WideToUtf8(slash ? slash + 1 : buf);
        if (name.size() > 4) {
            std::string ext = name.substr(name.size() - 4);
            for (auto& c : ext) c = (char)tolower((unsigned char)c);
            if (ext == ".exe") name = name.substr(0, name.size() - 4);
        }
    } else {
        name = "unknown";
    }
    CloseHandle(hProc);
    return name;
}

struct SessionInfo {
    DWORD       pid      = 0;
    std::string procName;
};

struct EnumWindowsCtx {
    std::set<DWORD>*             seen;
    std::vector<SessionInfo>*    results;
};

static BOOL CALLBACK WindowEnumProc(HWND hwnd, LPARAM lParam)
{
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
    if (GetWindowTextLengthW(hwnd) == 0) return TRUE;

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return TRUE;

    auto* ctx = reinterpret_cast<EnumWindowsCtx*>(lParam);
    if (!ctx->seen->insert(pid).second) return TRUE;

    SessionInfo info;
    info.pid      = pid;
    info.procName = GetProcessName(pid);
    ctx->results->push_back(std::move(info));
    return TRUE;
}

static std::vector<SessionInfo> EnumerateSessions()
{
    std::vector<SessionInfo> results;
    std::set<DWORD> seen;
    EnumWindowsCtx ctx{ &seen, &results };
    EnumWindows(WindowEnumProc, reinterpret_cast<LPARAM>(&ctx));
    return results;
}

static std::string JsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 4);
    for (unsigned char c : s) {
        if      (c == '"')  out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c < 0x20)  { char buf[8]; std::snprintf(buf, sizeof(buf), "\\u%04x", c); out += buf; }
        else                out += (char)c;
    }
    return out;
}

static void PrintJson(const std::vector<SessionInfo>& sessions)
{
    std::printf("[\n");
    for (size_t i = 0; i < sessions.size(); ++i) {
        if (i > 0) std::printf(",\n");
        std::printf("  { \"name\": \"%s\", \"pid\": %lu }",
                    JsonEscape(sessions[i].procName).c_str(),
                    (unsigned long)sessions[i].pid);
    }
    std::printf("\n]\n");
}

int main()
{
    auto sessions = EnumerateSessions();
    PrintJson(sessions);
    return 0;
}

