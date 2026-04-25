// qml-renderer — Qt-WASM harness that receives QML source from JavaScript
// and renders it live in a <canvas>. Compiled to WebAssembly so the no-code
// builder can preview a user-edited QML tree without round-tripping to a
// server. Communication with the surrounding JS is via emscripten_run_script
// → an exported C function loadQml(source) that JS calls with the new QML.

#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlComponent>
#include <QQuickItem>
#include <QQuickWindow>
#include <QQuickView>
#include <QQmlContext>
#include <QEventLoop>
#include <QTimer>
#include <QString>
#include <QByteArray>
#include <QUrl>
#include <QDebug>

#include <emscripten.h>
#include <emscripten/bind.h>

namespace {
QQuickView* g_view = nullptr;

// Replace the current QQuickView's root QML with the given source. Called
// from JavaScript via emscripten::function below. We use setSource(QUrl) on
// a dynamically-created data: URL because QQuickView::setSource takes a URL,
// and rebuilding the view is the simplest reliable way to re-render.
void loadQmlImpl(const std::string& source)
{
    if (!g_view) {
        qWarning() << "renderer: g_view not initialised yet";
        return;
    }

    // Wrap user source in a minimal Item shell so a missing root Item still
    // produces a valid component, and so we always start from a known import
    // baseline matching Basecamp's QML sandbox.
    const QByteArray prelude =
        "import QtQuick 2.15\n"
        "import QtQuick.Controls 2.15\n"
        "import QtQuick.Layouts 1.15\n";
    const QByteArray full = prelude + QByteArray::fromStdString(source);

    // Heap-allocate the component so it survives this function — the view
    // holds a non-owning reference until the next call. Each loadQml leaks
    // the previous component; for a workshop renderer with sub-second edit
    // cadence this is fine.
    auto* engine = g_view->engine();
    auto* component = new QQmlComponent(engine);
    component->setData(full, QUrl("inline://main.qml"));

    // Inline data should resolve synchronously, but Qt occasionally returns
    // Loading status for the first call. Spin a nested event loop until it
    // settles — bounded so we don't hang on a runaway import.
    if (component->isLoading()) {
        QEventLoop spin;
        QObject::connect(component, &QQmlComponent::statusChanged, &spin, &QEventLoop::quit);
        QTimer::singleShot(2000, &spin, &QEventLoop::quit);
        spin.exec();
    }

    if (component->isError() || !component->isReady()) {
        const QString why = component->isError()
            ? component->errorString()
            : QStringLiteral("component status=%1 (not Ready)").arg(component->status());
        qWarning().noquote() << "renderer: QML failed —" << why;

        const QString errorQml = QStringLiteral(
            "import QtQuick 2.15\n"
            "Rectangle { width: 800; height: 600; color: '#fde7e9';"
            " Text { anchors.centerIn: parent; text: 'QML error: %1';"
            "   color: '#b3261e'; wrapMode: Text.WordWrap;"
            "   width: parent.width - 32 } }").arg(
                QString(why).replace("'", "\\'").replace("\n", " "));

        auto* fallback = new QQmlComponent(engine);
        fallback->setData(errorQml.toUtf8(), QUrl("inline://err.qml"));
        if (fallback->isReady()) {
            if (auto* item = qobject_cast<QQuickItem*>(fallback->create())) {
                g_view->setContent(QUrl("inline://err.qml"), fallback, item);
            }
        }
        delete component;
        return;
    }

    auto* obj = component->create();
    auto* item = qobject_cast<QQuickItem*>(obj);
    if (!item) {
        qWarning() << "renderer: root is not a QQuickItem";
        delete obj;
        delete component;
        return;
    }
    g_view->setContent(QUrl("inline://main.qml"), component, item);
}
}

// Exported C entry point — JS calls Module.loadQml(source) (via the
// emscripten::function binding below).
EMSCRIPTEN_BINDINGS(renderer) {
    emscripten::function("loadQml", &loadQmlImpl);
}

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);

    QQuickView view;
    view.setResizeMode(QQuickView::SizeRootObjectToView);
    view.resize(800, 600);
    view.show();

    g_view = &view;

    // Boot with a "no QML loaded" placeholder so the canvas isn't blank.
    // Root item gets explicit size — anchors.fill: parent doesn't work on a
    // QQuickView root because it has no parent.
    loadQmlImpl(
        "Rectangle { width: 800; height: 600; color: '#f8f9fa'; "
        "Text { anchors.centerIn: parent; "
        "       text: 'Renderer ready — call Module.loadQml(\"...\")'; "
        "       color: '#666'; font.pixelSize: 14 } }");

    return app.exec();
}
