# Generate web-bridge-demo.inc: the demo/ tree embedded as C string
# literals, for seeding into the wasm MEMFS at startup.
#
# Invoked as:
#   cmake -DDEMO_SRC=<dir> -DDEMO_INC=<out> -P cmake/gen-demo-inc.cmake
#
# Paths in the generated table are relative to / (i.e. "/demo/..."),
# matching where the seed function writes them into MEMFS.

if(NOT DEFINED DEMO_SRC OR NOT DEFINED DEMO_INC)
  message(FATAL_ERROR "need -DDEMO_SRC=<dir> -DDEMO_INC=<out>")
endif()

file(GLOB_RECURSE _all RELATIVE ${DEMO_SRC} ${DEMO_SRC}/*)
set(_files "")
foreach(f ${_all})
  if(NOT IS_DIRECTORY ${DEMO_SRC}/${f})
    list(APPEND _files ${f})
  endif()
endforeach()
list(SORT _files)

set(_out "/* Auto-generated from ${DEMO_SRC} -- do not edit. */\n\n")
string(APPEND _out "typedef struct {\n")
string(APPEND _out "\tconst char *path;\n")
string(APPEND _out "\tconst char *data;\n")
string(APPEND _out "} demo_file_t;\n\n")
string(APPEND _out "static const demo_file_t DEMO_FILES[] = {\n")

foreach(f ${_files})
  file(READ ${DEMO_SRC}/${f} _data)
  # Escape into a C string body (backslash first, then quote, then the
  # control characters; CR is dropped).
  string(REPLACE "\\" "\\\\" _data "${_data}")
  string(REPLACE "\"" "\\\"" _data "${_data}")
  string(REPLACE "\n" "\\n" _data "${_data}")
  string(REPLACE "\t" "\\t" _data "${_data}")
  string(REPLACE "\r" "" _data "${_data}")
  string(APPEND _out "\t{ \"/demo/${f}\", \"${_data}\" },\n")
endforeach()

string(APPEND _out "};\n")
file(WRITE ${DEMO_INC} "${_out}")