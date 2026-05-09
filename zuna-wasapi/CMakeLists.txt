cmake_minimum_required(VERSION 3.31)
project(zuna_wasapi)

set(CMAKE_CXX_STANDARD 20)

add_compile_definitions(
    WINVER=0x0A00
    _WIN32_WINNT=0x0A00
    UNICODE
    _UNICODE
)

add_link_options(
    -static
    -static-libgcc
    -static-libstdc++
)

add_executable(zuna_wasapi main.cpp)
target_link_libraries(zuna_wasapi PRIVATE ole32 avrt mmdevapi)

add_executable(zuna_wasapi_scan scan.cpp)
target_link_libraries(zuna_wasapi_scan PRIVATE ole32 mmdevapi psapi)
