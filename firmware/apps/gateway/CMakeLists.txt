cmake_minimum_required(VERSION 3.20.0)

# The SonicMesh library is a Zephyr module two levels up.
list(APPEND ZEPHYR_EXTRA_MODULES ${CMAKE_CURRENT_SOURCE_DIR}/../..)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(sonicmesh_gateway)

target_sources(app PRIVATE src/main.c)
