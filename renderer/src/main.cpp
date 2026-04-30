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
#include <QTimer>
#include <QString>
#include <QByteArray>
#include <QUrl>
#include <QDebug>

#include <memory>

#include <emscripten.h>
#include <emscripten/bind.h>

namespace {
QQuickView* g_view = nullptr;
// The component issued by the most recent loadQmlImpl call. Used by
// finalizeQml to ignore late-arriving async callbacks from earlier
// components — without this, the boot placeholder's Loading→Ready
// statusChanged callback fires AFTER the user's QML has already rendered
// and overwrites it with the boot placeholder. (Qt's QML type loader
// resolves `import QtQuick` async on first use, so the very first setData
// always goes async even though it looks inline.)
QQmlComponent* g_latestComponent = nullptr;

// Final-stage handler — takes a QQmlComponent that has settled (Ready or
// Error) and either renders it into g_view or shows a fallback error
// surface. Called both for synchronously-ready components and async-
// settled ones. Mirrors the previous code's lifetime semantics: success
// path leaks the component (the view holds a non-owning reference); error
// path deletes it and leaks the small fallback component instead.
void finalizeQml(QQmlComponent* component)
{
    qDebug() << "renderer/finalizeQml: entered, component status="
             << (component ? int(component->status()) : -1)
             << " latest=" << g_latestComponent
             << " this=" << component;
    if (!g_view || !component) {
        if (component) delete component;
        return;
    }
    // Stale guard: an async statusChanged callback from an EARLIER
    // loadQmlImpl call (typically the boot placeholder finally resolving
    // its QtQuick imports). A newer loadQml has already taken over.
    // Rendering this would clobber the user's current QML.
    if (component != g_latestComponent) {
        qDebug() << "renderer/finalizeQml: stale component — skipping (already superseded)";
        // Don't delete: the lambda holding the connection is still on the
        // stack. The component leaks; harmless given the workshop-scale
        // edit cadence here.
        return;
    }

    auto* engine = g_view->engine();

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
        qWarning() << "renderer: root is not a QQuickItem (was:"
                   << (obj ? obj->metaObject()->className() : "null") << ")";
        delete obj;
        delete component;
        return;
    }
    qDebug() << "renderer/finalizeQml: calling setContent, item ="
             << item << " size:" << item->width() << "x" << item->height();
    g_view->setContent(QUrl("inline://main.qml"), component, item);
    qDebug() << "renderer/finalizeQml: setContent done";
}

// Replace the current QQuickView's root QML with the given source. Called
// from JavaScript via emscripten::function below.
void loadQmlImpl(const std::string& source)
{
    qDebug() << "renderer/loadQmlImpl: called with source.size=" << source.size();
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
    g_latestComponent = component;  // mark as latest BEFORE setData so any
                                    // sync statusChanged sees us as latest
    component->setData(full, QUrl("inline://main.qml"));
    qDebug() << "renderer/loadQmlImpl: post-setData status=" << int(component->status())
             << " isLoading=" << component->isLoading()
             << " isReady=" << component->isReady()
             << " isError=" << component->isError();

    // Inline data USUALLY resolves synchronously, but Qt occasionally
    // returns Loading. We previously waited via QEventLoop::exec() — that
    // aborts on the WASM main thread without asyncify with the message
    // "QEventLoop::WaitForMoreEvents is not supported on the main thread
    // without asyncify", and the renderer then hangs forever at boot
    // (the user sees an indefinite "Loading renderer..." overlay). The
    // wasm_singlethread Qt build deliberately ships without asyncify
    // (~2x binary size + runtime cost), so we can't enable that escape.
    //
    // Instead: when the component is still loading, register a one-shot
    // continuation on statusChanged + a 2s safety timer, and return — the
    // browser keeps spinning the JS event loop normally. The shared_ptr<bool>
    // ensures only the first of (signal, timer) wins; finalizeQml runs once.
    if (component->isLoading()) {
        auto done = std::make_shared<bool>(false);
        QObject::connect(component, &QQmlComponent::statusChanged, component,
            [component, done](QQmlComponent::Status status) {
                if (*done || status == QQmlComponent::Loading) return;
                *done = true;
                finalizeQml(component);
            });
        QTimer::singleShot(2000, component, [component, done]() {
            if (*done) return;
            *done = true;
            // finalizeQml will route to the error fallback if the component
            // never reached Ready (e.g. runaway import).
            finalizeQml(component);
        });
        return;
    }

    finalizeQml(component);
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
