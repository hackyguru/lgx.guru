#ifndef DELIVERY_RELAY_INTERFACE_H
#define DELIVERY_RELAY_INTERFACE_H

#include <QObject>
#include <QString>
#include "interface.h"

// QML-facing surface of the shared delivery relay. UIs built with lgx.guru
// call these via logos.callModule("delivery_relay", "<method>", [...]).
//
// All UIs share one installed relay — install once per Basecamp, every
// delivery-enabled widget reuses it.
class DeliveryRelayInterface : public PluginInterface
{
public:
    virtual ~DeliveryRelayInterface() = default;

    // Initialise the underlying delivery_module node + connect to peers.
    // Idempotent — safe to call from every widget's Component.onCompleted.
    Q_INVOKABLE virtual bool    startDelivery() = 0;

    // Disconnect + unsubscribe everything. Generally not called from widgets.
    Q_INVOKABLE virtual bool    stopDelivery() = 0;

    // 0=off, 1=connecting, 2=connected, 3=error.
    Q_INVOKABLE virtual int     deliveryStatus() = 0;

    // Publish a payload on a content topic. Topic format:
    //   /<app>/<version>/<subtopic>/<format>   e.g. /chat/1/messages/text
    Q_INVOKABLE virtual bool    sendMessage(const QString& contentTopic, const QString& payload) = 0;

    // Start receiving on a topic. Idempotent.
    Q_INVOKABLE virtual bool    subscribeToTopic(const QString& contentTopic) = 0;

    // Stop receiving on a topic.
    Q_INVOKABLE virtual bool    unsubscribeFromTopic(const QString& contentTopic) = 0;

    // Return + drain the in-memory queue of received messages. JSON array of
    // { topic, payload, hash, timestamp }. Widgets poll this on a Timer.
    Q_INVOKABLE virtual QString takeRecentMessages() = 0;
};

#define DeliveryRelayInterface_iid "org.logos.DeliveryRelayInterface"
Q_DECLARE_INTERFACE(DeliveryRelayInterface, DeliveryRelayInterface_iid)

#endif
