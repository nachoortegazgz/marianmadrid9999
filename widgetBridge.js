/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.5-FUNCTIONAL + revision revisada
RESPONSIBILITY: Comunicacion segura entre paginas Velo y widgets HTML.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: cabecera actualizada.
  - V20-02: revision revisada. Anade validacion de origen, limite de
            tamano de mensaje, whitelist de tipos, y desuscripcion segura.
  - V20-03: onWidgetMessage recibe (message, bridge). Los consumidores
            antiguos que esperaban (message, reply) deben actualizarse a
            bridge.reply(...) o bridge.send(...).

NOTA DE INTEGRACION: calendario-2.js y servicio-2.js deben actualizarse
para usar bridge.reply(...) en lugar del parametro reply. Ver checklist.
=============================================================================
*/

const DEFAULT_ALLOWED_TYPES = new Set([
  "MM_READY",
  "MM_CONTEXT",
  "MM_AVAIL",
  "MM_SELECT",
  "MM_BOOK",
  "MM_NAV",
]);

const MAX_MESSAGE_BYTES = 100000;

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeType(value) {
  const type = String(value || "")
    .trim()
    .toUpperCase();
  return type.slice(0, 40);
}

function safeMessageId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "_")
    .slice(0, 120);
}

function estimateSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

export function createWidgetBridge(widgetElement, options = {}) {
  if (
    !widgetElement ||
    typeof widgetElement.onMessage !== "function" ||
    typeof widgetElement.postMessage !== "function"
  ) {
    throw new TypeError("A valid HTML Component is required");
  }

  const allowedOrigin = String(options.allowedOrigin || "").trim();
  const allowedTypes = new Set(options.allowedTypes || DEFAULT_ALLOWED_TYPES);
  const onError =
    typeof options.onError === "function" ? options.onError : () => {};
  const onMessage =
    typeof options.onMessage === "function" ? options.onMessage : () => {};
  const onContextReady =
    typeof options.onContextReady === "function" ? options.onContextReady : null;
  const onWidgetMessage =
    typeof options.onWidgetMessage === "function"
      ? options.onWidgetMessage
      : null;

  let destroyed = false;
  let sequence = 0;

  function fail(code, detail = null) {
    const error = new Error(code);
    error.code = code;
    try {
      onError(error, detail);
    } catch (_) {}
  }

  function extractEvent(event) {
    const origin = String(event?.origin || "");
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      fail("WIDGET_ORIGIN_REJECTED", { origin });
      return null;
    }

    const message = safeObject(event?.data);
    if (estimateSize(message) > MAX_MESSAGE_BYTES) {
      fail("WIDGET_MESSAGE_TOO_LARGE");
      return null;
    }

    return message;
  }

  function normalizeMessage(message) {
    const source = safeObject(message);
    const type = safeType(source.type || source.messageType || source.eventType);

    if (!allowedTypes.has(type)) return null;

    const payload = safeObject(source.payload || source.data);
    const messageId = safeMessageId(source.messageId || source.id);

    return {
      type,
      payload,
      messageId,
      requestId: messageId,
      version: source.version || 1,
    };
  }

  function send(type, payload = {}, messageId = null) {
    if (destroyed) throw new Error("WIDGET_BRIDGE_DESTROYED");

    const normalizedType = safeType(type);
    if (!allowedTypes.has(normalizedType)) {
      throw new Error("WIDGET_MESSAGE_TYPE_NOT_ALLOWED");
    }

    const message = {
      type: normalizedType,
      payload: safeObject(payload),
      messageId:
        safeMessageId(messageId) ||
        `msg-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
      version: 1,
    };

    if (estimateSize(message) > MAX_MESSAGE_BYTES) {
      throw new Error("WIDGET_MESSAGE_TOO_LARGE");
    }

    widgetElement.postMessage(message);
    return message.messageId;
  }

  function reply(type, payload, requestMessage) {
    return send(
      type,
      payload,
      requestMessage?.messageId || requestMessage?.requestId || null
    );
  }

  function postMessage(payload, type = "MM_CONTEXT") {
    return send(type, payload);
  }

  const unsubscribe = widgetElement.onMessage((event) => {
    if (destroyed) return;

    try {
      const message = normalizeMessage(extractEvent(event));

      if (!message) {
        fail("WIDGET_MESSAGE_REJECTED");
        return;
      }

      onMessage(message);

      if (onWidgetMessage) onWidgetMessage(message, bridge);

      if (message.type === "MM_READY" && onContextReady) {
        Promise.resolve(onContextReady(message))
          .then((context) => {
            if (context !== undefined && context !== null) {
              send("MM_CONTEXT", context, message.messageId);
            }
          })
          .catch((error) => fail("WIDGET_CONTEXT_FAILED", error));
      }
    } catch (error) {
      fail(error?.code || "WIDGET_MESSAGE_HANDLER_FAILED", error);
    }
  });

  const bridge = {
    widget: widgetElement,

    get destroyed() {
      return destroyed;
    },

    origin: allowedOrigin,
    type: "WIX_HTML_COMPONENT_BRIDGE",

    postMessage,
    send,
    reply,

    onMessage(callback) {
      return typeof callback === "function" ? callback : () => {};
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (typeof unsubscribe === "function") {
        try {
          unsubscribe();
        } catch (_) {}
      }
    },
  };

  return bridge;
}

export default createWidgetBridge;