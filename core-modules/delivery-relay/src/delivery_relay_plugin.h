#ifndef DELIVERY_RELAY_PLUGIN_H
#define DELIVERY_RELAY_PLUGIN_H

#include <QObject>
#include <QString>
#include <QStringList>
#include <QVariant>
#include <QJsonArray>
#include "delivery_relay_interface.h"
#include "logos_api.h"
#include "logos_api_client.h"
#include "logos_object.h"
#include "logos_sdk.h"

class DeliveryRelayPlugin : public QObject, public DeliveryRelayInterface
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID DeliveryRelayInterface_iid FILE "metadata.json")
    Q_INTERFACES(DeliveryRelayInterface PluginInterface)

public:
    explicit DeliveryRelayPlugin(QObject* parent = nullptr);
    ~DeliveryRelayPlugin() override;

    QString name() const override { return "delivery_relay"; }
    QString version() const override { return "0.1.0"; }

    Q_INVOKABLE void initLogos(LogosAPI* api);

    Q_INVOKABLE bool    startDelivery() override;
    Q_INVOKABLE bool    stopDelivery() override;
    Q_INVOKABLE int     deliveryStatus() override;
    Q_INVOKABLE bool    sendMessage(const QString& contentTopic, const QString& payload) override;
    Q_INVOKABLE bool    subscribeToTopic(const QString& contentTopic) override;
    Q_INVOKABLE bool    unsubscribeFromTopic(const QString& contentTopic) override;
    Q_INVOKABLE QString takeRecentMessages() override;

signals:
    void eventResponse(const QString& eventName, const QVariantList& args);

private:
    void handleMessageReceived(const QVariantList& data);
    void setDeliveryStatus(int status);

    // NOTE: LogosAPI is held by the inherited PluginInterface::logosAPI
    // member — Basecamp's runtime dispatches calls based on that pointer,
    // so initLogos must assign there (not into a private duplicate).
    LogosAPIClient* m_deliveryClient = nullptr;
    LogosObject*    m_deliveryObject = nullptr;

    int          m_deliveryStatus  = 0;     // 0=off,1=connecting,2=connected,3=error
    bool         m_deliveryStarted = false;
    QStringList  m_subscribedTopics;
    QJsonArray   m_messageQueue;            // drained by takeRecentMessages()
};

#endif
