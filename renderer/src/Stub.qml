// Stub.qml — never instantiated. Its only job is to declare the QML
// imports the static build needs to link in (qtquick2plugin,
// qtquickcontrols2plugin, qtquicklayoutsplugin). The CMake QML module
// scaffolding walks these imports and pulls the matching static plugin
// libraries into the binary so `import QtQuick 2.15` works at runtime.

import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Item {}
