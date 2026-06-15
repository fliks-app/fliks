# Fliks desktop — Qt6 + QtWebEngine shell. The web UI renders in a transparent
# window; in-process libmpv renders video into a Wayland subsurface BELOW it
# (avoids QtWebEngine transparent ghosting, QTBUG-111739).
cmake_minimum_required(VERSION 3.21)
project(fliks_qt_spike LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.4 REQUIRED COMPONENTS
  Core Gui Quick Qml OpenGL
  WebEngineQuick WebEngineCore WebChannel)
find_package(PkgConfig REQUIRED)
pkg_check_modules(MPV REQUIRED IMPORTED_TARGET mpv)
pkg_check_modules(WAYLAND REQUIRED IMPORTED_TARGET wayland-client wayland-egl egl)

qt_add_executable(fliks_qt_spike
  src/main.cpp
  src/mpvplayer.cpp
  src/mpvplayer.h
  src/schemehandler.cpp
  src/schemehandler.h
)

target_compile_definitions(fliks_qt_spike PRIVATE
  QML_MAIN="${CMAKE_CURRENT_SOURCE_DIR}/qml/main.qml"
  SHIM_JS="${CMAKE_CURRENT_SOURCE_DIR}/qml/bridge-shim.js")

# qpa/qplatformnativeinterface.h (window wl_surface). aqt ships the private
# headers but not the Qt6GuiPrivate cmake module, so add the path by hand.
target_include_directories(fliks_qt_spike PRIVATE
  "${CMAKE_PREFIX_PATH}/include/QtGui/${Qt6_VERSION}"
  "${CMAKE_PREFIX_PATH}/include/QtGui/${Qt6_VERSION}/QtGui")

target_link_libraries(fliks_qt_spike PRIVATE
  Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::OpenGL
  Qt6::WebEngineQuick Qt6::WebEngineCore Qt6::WebChannel
  PkgConfig::MPV PkgConfig::WAYLAND
)
