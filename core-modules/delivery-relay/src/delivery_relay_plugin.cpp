#include "delivery_relay_plugin.h"

#include <QByteArray>
#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>

DeliveryRelayPlugin::DeliveryRelayPlugin(QObject* parent) : QObject(parent)
{
}

DeliveryRelayPlugin::~DeliveryRelayPlugin()
{
    if (m_deliveryStarted) {
        stopDelivery();
    }
}

void DeliveryRelayPlugin::initLogos(LogosAPI* api)
{
    // Assign to the inherited PluginInterface::logosAPI — Basecamp's
    // runtime checks that pointer to dispatch calls into us. A private
    // duplicate (e.g. m_api) leaves logosAPI null and ModuleProxy logs
    // "LogosAPI not available" while every callModule no-ops.
    logosAPI = api;
    // Grab the delivery client now; createNode + onEvent + start are deferred
    // to startDelivery() so handlers attach BEFORE start (so we don't miss
    // the first connectionStateChanged).
    m_deliveryClient = logosAPI->getClient("delivery_module");
}

bool DeliveryRelayPlugin::startDelivery()
{
    if (m_deliveryStarted) return true;
    setDeliveryStatus(1);
    if (!m_deliveryClient) {
        qWarning() << "DeliveryRelayPlugin: delivery_module client unavailable";
        setDeliveryStatus(3);
        return false;
    }

    // logos.dev preset = cluster 2, built-in bootstraps. Set POLLING_TCPPORT
    // env var to a free port (e.g. 60001) when running two Basecamps on one
    // machine so the two delivery nodes don't collide on the default 60000.
    QJsonObject cfgObj;
    cfgObj["logLevel"] = "INFO";
    cfgObj["mode"]     = "Core";
    cfgObj["preset"]   = "logos.dev";
    const int customPort = qEnvironmentVariableIntValue("POLLING_TCPPORT");
    if (customPort > 0) {
        cfgObj["tcpPort"]       = customPort;
        cfgObj["discv5UdpPort"] = 9000 + (customPort - 60000);
    }
    const QString cfg = QString::fromUtf8(
        QJsonDocument(cfgObj).toJson(QJsonDocument::Compact));

    QVariant r = m_deliveryClient->invokeRemoteMethod(
        "delivery_module", "createNode", cfg);
    if (!r.isValid() || !r.toBool()) {
        qWarning() << "DeliveryRelayPlugin: createNode failed";
        setDeliveryStatus(3);
        return false;
    }

    // Register handlers BEFORE start — connectionStateChanged fires synchronously
    // from start() and any handler not yet attached will miss it.
    m_deliveryObject = m_deliveryClient->requestObject("delivery_module");
    if (m_deliveryObject) {
        m_deliveryClient->onEvent(m_deliveryObject, "messageReceived",
            [this](const QString&, const QVariantList& data) {
                handleMessageReceived(data);
            });
        m_deliveryClient->onEvent(m_deliveryObject, "connectionStateChanged",
            [this](const QString&, const QVariantList& data) {
                if (data.isEmpty()) return;
                const QString s = data[0].toString();
                if (s.contains("Connected", Qt::CaseInsensitive))      setDeliveryStatus(2);
                else if (!s.isEmpty())                                 setDeliveryStatus(1);
            });
    } else {
        qWarning() << "DeliveryRelayPlugin: no delivery_module object — events will be missed";
    }

    r = m_deliveryClient->invokeRemoteMethod("delivery_module", "start");
    if (!r.isValid() || !r.toBool()) {
        qWarning() << "DeliveryRelayPlugin: start failed";
        setDeliveryStatus(3);
        return false;
    }
    m_deliveryStarted = true;
    return true;
}

bool DeliveryRelayPlugin::stopDelivery()
{
    if (!m_deliveryStarted) return true;
    if (m_deliveryClient) {
        for (const QString& topic : m_subscribedTopics) {
            m_deliveryClient->invokeRemoteMethod(
                "delivery_module", "unsubscribe", topic);
        }
        m_deliveryClient->invokeRemoteMethod("delivery_module", "stop");
    }
    m_subscribedTopics.clear();
    m_deliveryObject = nullptr;
    m_deliveryStarted = false;
    setDeliveryStatus(0);
    return true;
}

int DeliveryRelayPlugin::deliveryStatus() { return m_deliveryStatus; }

bool DeliveryRelayPlugin::sendMessage(const QString& contentTopic, const QString& payload)
{
    if (!m_deliveryStarted && !startDelivery()) return false;
    QVariant r = m_deliveryClient->invokeRemoteMethod(
        "delivery_module", "send", contentTopic, payload);
    return r.isValid();
}

bool DeliveryRelayPlugin::subscribeToTopic(const QString& contentTopic)
{
    if (!m_deliveryStarted && !startDelivery()) return false;
    if (m_subscribedTopics.contains(contentTopic)) return true;
    QVariant r = m_deliveryClient->invokeRemoteMethod(
        "delivery_module", "subscribe", contentTopic);
    if (!r.isValid() || !r.toBool()) return false;
    m_subscribedTopics.append(contentTopic);
    return true;
}

bool DeliveryRelayPlugin::unsubscribeFromTopic(const QString& contentTopic)
{
    if (!m_deliveryClient) return false;
    QVariant r = m_deliveryClient->invokeRemoteMethod(
        "delivery_module", "unsubscribe", contentTopic);
    m_subscribedTopics.removeAll(contentTopic);
    return r.isValid();
}

QString DeliveryRelayPlugin::takeRecentMessages()
{
    const QString out = QString::fromUtf8(
        QJsonDocument(m_messageQueue).toJson(QJsonDocument::Compact));
    m_messageQueue = QJsonArray();   // drain
    return out;
}

void DeliveryRelayPlugin::handleMessageReceived(const QVariantList& data)
{
    // delivery_module.messageReceived: [hash, contentTopic, payload_base64, timestamp_ns]
    if (data.size() < 3) return;
    const QString    hash    = data[0].toString();
    const QString    topic   = data[1].toString();
    const QByteArray bytes   = QByteArray::fromBase64(data[2].toString().toUtf8());
    const QString    payload = QString::fromUtf8(bytes);
    const QString    ts      = data.size() >= 4 ? data[3].toString() : QString();
    QJsonObject o;
    o["topic"]     = topic;
    o["payload"]   = payload;
    o["hash"]      = hash;
    o["timestamp"] = ts;
    m_messageQueue.append(o);
    // Cap the queue so a slow UI poll doesn't grow it unbounded.
    while (m_messageQueue.size() > 1000) m_messageQueue.removeAt(0);
    emit eventResponse("messageReceived", QVariantList{ topic, payload });
}

void DeliveryRelayPlugin::setDeliveryStatus(int status)
{
    if (m_deliveryStatus == status) return;
    m_deliveryStatus = status;
    emit eventResponse("deliveryStatusChanged", QVariantList{ status });
}
