# CMake toolchain file for building the web interpreter with emscripten.
#
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/emscripten.cmake
#
# Requires an activated emsdk environment (emcc on PATH). The same file is
# passed to the ucode external project (see CMakeLists.txt), which detects
# the emscripten compiler and builds its static wasm libraries.

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER emcc)
set(CMAKE_CXX_COMPILER em++)
set(CMAKE_ASM_COMPILER emcc)

set(CMAKE_C_COMPILER_WORKS TRUE)
set(CMAKE_CXX_COMPILER_WORKS TRUE)