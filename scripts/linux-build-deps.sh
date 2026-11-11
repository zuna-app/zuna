#!/bin/sh
# Installs what building the native app's Linux packages needs, in the Debian 12 container the
# release workflow and ci.yml's linux job build them in. Debian 12 is what the packages are built
# against, so that the program runs wherever glibc is that old or newer.
#
# LiveKit's libwebrtc is built with a libc++ of its own that only clang 21 or later reads, which
# Debian 12 doesn't have, so clang comes from LLVM's own packages for it. The workflows point CC,
# CXX and LIBCLANG_PATH at it.
set -eu

apt-get update
# What the build links or reads headers of, and what makes the packages. WebKitGTK is zuna-watch's,
# the window a video watched together plays in.
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils zstd unzip build-essential cmake pkg-config \
  libxkbcommon-dev libwayland-dev libfontconfig-dev libfreetype-dev libpipewire-0.3-dev libglib2.0-dev libva-dev libdrm-dev libgbm-dev libegl-dev libdbus-1-dev \
  libwebkitgtk-6.0-dev \
  desktop-file-utils squashfs-tools

curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key -o /etc/apt/keyrings/llvm.asc
echo "deb [signed-by=/etc/apt/keyrings/llvm.asc] http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-21 main" > /etc/apt/sources.list.d/llvm.list
apt-get update
apt-get install -y --no-install-recommends clang-21 libclang-21-dev
