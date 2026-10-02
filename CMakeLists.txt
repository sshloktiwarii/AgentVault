cmake_minimum_required(VERSION 3.15)
project(rewind_bpf)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include_directories(${CMAKE_JS_INC})

# Source files
file(GLOB SOURCE_FILES "src/kernel/binding.cpp")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_library(LIBBPF_LIB bpf)
    if(LIBBPF_LIB)
        target_link_libraries(${PROJECT_NAME} ${LIBBPF_LIB})
    endif()
endif()
