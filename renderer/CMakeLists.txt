cmake_minimum_required(VERSION 3.21)
project(qml-renderer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.7 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2)

qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(qml-renderer
    src/main.cpp
)

# Static Qt-WASM: QML plugin static initializers don't run unless they're
# linked in. Declare the renderer itself as a QML module with a stub QML
# file that imports the modules we need at runtime — the build system then
# walks the imports and links the corresponding plugins.
qt_add_qml_module(qml-renderer
    URI Renderer
    VERSION 1.0
    QML_FILES src/Stub.qml
)

target_link_libraries(qml-renderer PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Quick
    Qt6::Qml
    Qt6::QuickControls2
)
