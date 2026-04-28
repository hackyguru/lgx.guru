// Hand-curated catalog of Logos backend modules the editor knows how to
// integrate with. Each ModuleSpec is everything we need to render an
// inspector form for "Call module method" actions and to bake the right
// dependency into the exported .lgx's metadata.json.
//
// API surface mirrors the C++ DeliveryModuleInterface from
// logos-co/logos-delivery-module — verified against the installed module's
// header in the local Logos store path.

import { ModuleSpec } from "../types";

export const MODULE_CATALOG: ModuleSpec[] = [
  {
    // The id is what gets passed to logos.callModule("<id>", ...) AND
    // what goes into metadata.json's dependencies array.
    id: "delivery_module",
    name: "Delivery",
    description:
      "Pub/sub messaging via Waku v2. Lifecycle: createNode (once) → start → [subscribe/send/unsubscribe]* → stop. Register event handlers BEFORE calling start — events fire during start() and unregistered handlers miss them.",
    methods: [
      { name: "createNode", args: [
          { name: "cfg", type: "string",
            description: 'Flat JSON config. Common keys: preset ("logos.dev" / "twn"), mode ("Core"), logLevel, tcpPort, discv5UdpPort. Individual keys override the preset.' },
        ], returns: "boolean",
        description: 'Initialise the node. Call exactly once per process before anything else. Example cfg: {"logLevel":"INFO","mode":"Core","preset":"logos.dev"}.' },

      { name: "start", args: [], returns: "boolean",
        description: "Connect to peers and start the gossipsub engine. Emits connectionStateChanged as it progresses." },

      { name: "stop", args: [], returns: "boolean",
        description: "Disconnect. Safe to start() again afterwards." },

      { name: "subscribe", args: [
          { name: "contentTopic", type: "string",
            description: "Format: /<app>/<version>/<subtopic>/<format> — e.g. /myapp/1/messages/json" },
        ], returns: "boolean",
        description: "Start receiving messageReceived events for this topic. Multiple subscribes are fine; duplicates are deduped internally." },

      { name: "unsubscribe", args: [
          { name: "contentTopic", type: "string" },
        ], returns: "boolean",
        description: "Stop receiving for this topic." },

      { name: "send", args: [
          { name: "contentTopic", type: "string",
            description: "Topic to publish on. See subscribe() for the format." },
          { name: "payload", type: "string",
            description: "QString — single base64 layer for binary payloads, or raw text (e.g. JSON) for text payloads." },
        ], returns: "string",
        description: "Publish a payload. Returns a LogosResult with a requestId; correlate with messageSent / messagePropagated / messageError events to confirm delivery." },

      { name: "getAvailableConfigs", args: [], returns: "string",
        description: "Returns available preset names (e.g. logos.dev, twn) as JSON." },

      { name: "getAvailableNodeInfoIDs", args: [], returns: "string",
        description: "Returns the list of node-info IDs available for getNodeInfo." },

      { name: "getNodeInfo", args: [
          { name: "nodeInfoId", type: "string" },
        ], returns: "string",
        description: "Returns a JSON blob of diagnostic info (peer count, node id, etc.)." },
    ],
    events: [
      { name: "connectionStateChanged",
        data: [
          { name: "status",    type: "string" },
          { name: "timestamp", type: "string" },
        ],
        description: 'status: "Connected" / "Connecting" / "Disconnected". Useful for showing live node state in the UI.' },
      { name: "messageReceived",
        data: [
          { name: "hash",            type: "string" },
          { name: "contentTopic",    type: "string" },
          { name: "payloadBase64",   type: "string" },
          { name: "timestampNs",     type: "number" },
        ],
        description: "A message arrived on a topic you subscribed to. Decode payloadBase64 (single decode for text payloads, double for binary)." },
      { name: "messageSent",
        data: [
          { name: "requestId",   type: "string" },
          { name: "messageHash", type: "string" },
          { name: "timestamp",   type: "string" },
        ],
        description: "Your send was queued by the local library." },
      { name: "messagePropagated",
        data: [
          { name: "requestId",   type: "string" },
          { name: "messageHash", type: "string" },
          { name: "timestamp",   type: "string" },
        ],
        description: "Your send was delivered to neighboring peers — the broadcast went out." },
      { name: "messageError",
        data: [
          { name: "requestId",   type: "string" },
          { name: "messageHash", type: "string" },
          { name: "error",       type: "string" },
          { name: "timestamp",   type: "string" },
        ],
        description: "A send failed (e.g. no peers). `error` is a human-readable reason." },
    ],
  },
];

// Convenience lookup. Falls back to undefined for unknown ids — the editor
// either skips emission for those calls or shows a "module no longer in
// catalog" warning in the inspector.
export const findModuleSpec = (id: string): ModuleSpec | undefined =>
  MODULE_CATALOG.find((m) => m.id === id);

export const findModuleMethod = (id: string, methodName: string) => {
  const m = findModuleSpec(id);
  return m ? m.methods.find((mm) => mm.name === methodName) : undefined;
};
