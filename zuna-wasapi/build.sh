#/usr/bin/env bash
set -e

cd build
mingw32-make -j$(nproc)

mkdir -p ../out
rm -f ../out/zuna_wasapi_scan.exe ../out/zuna_wasapi.exe
mv zuna_wasapi_scan.exe ../out/zuna_wasapi_scan.exe
mv zuna_wasapi.exe ../out/zuna_wasapi.exe