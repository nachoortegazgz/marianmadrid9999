/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5007.5-FUNCTIONAL
RESPONSIBILITY: Comunicacion segura entre paginas Velo y widgets HTML.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import { MESSAGE_TYPES } from "public/mmUtils";

const WILDCARD_ORIGIN = "*";

function _safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function _getMessageData(event) {
  if (event && typeof event === "object" && "data" in event) {
    return event.data;
  }

  return event;
}

function _getMessageType(message) {
  const data = _getMessageData(message);

  return String(
    data?.type ||
    data?.action ||
    ""
  )
    .trim()
    .toUpperCase();
}

function _getPayload(message) {
  const data = _getMessageData(message);

  if (
    data &&
    typeof data === "object" &&
    data.payload &&
    typeof data.payload === "object"
  ) {
    return data.payload;
  }

  return _safeObject(data);
}

function _getReplyMessageId(message) {
  const data = _getMessageData(message);

  return data?.messageId ||
    data?.requestId ||
    data?.payload?.messageId ||
    null;
}

function _safeCallback(callback, args, onError) {
  if (typeof callback !== "function") {
    return undefined;
  }

  try {
    return callback(...args);
  } catch (error) {
    if (typeof onError === "function") {
      try {
        onError(error);
      } catch (_) {
        // Consumer errors must not break the bridge.
      }
    }

    return undefined;
  }
}

function _sendToWidget(widgetElement, message) {
  if (
    !widgetElement ||
    typeof widgetElement.postMessage !== "function"
  ) {
    throw new Error(
      "widgetBridge: widget.postMessage is unavailable"
    );
  }

  widgetElement.postMessage(message);
}

export function createWidgetBridge(
  widgetElement,
  options = {}
) {
  if (!widgetElement) {
    throw new Error(
      "widgetBridge: widgetElement is required"
    );
  }

  if (
    typeof widgetElement.postMessage !== "function"
  ) {
    throw new Error(
      "widgetBridge: widget.postMessage is unavailable"
    );
  }

  const onError =
    typeof options.onError === "function"
      ? options.onError
      : null;

  const onMessage =
    typeof options.onMessage === "function"
      ? options.onMessage
      : null;

  const onContextReady =
    typeof options.onContextReady === "function"
      ? options.onContextReady
      : null;

  const onWidgetMessage =
    typeof options.onWidgetMessage === "function"
      ? options.onWidgetMessage
      : null;

  const messageTypes = {
    READY: MESSAGE_TYPES?.READY || "MM_READY",
    CONTEXT: MESSAGE_TYPES?.CONTEXT || "MM_CONTEXT",
    AVAIL: MESSAGE_TYPES?.AVAIL || "MM_AVAIL",
    SELECT: MESSAGE_TYPES?.SELECT || "MM_SELECT",
    BOOK: MESSAGE_TYPES?.BOOK || "MM_BOOK",
    NAV: MESSAGE_TYPES?.NAV || "MM_NAV"
  };

  let destroyed = false;
  let contextSent = false;
  let widgetListener = null;

  const reportError = (error, context = null) => {
    if (typeof onError !== "function") {
      return;
    }

    try {
      onError(error, context);
    } catch (_) {
      // Consumer errors must not break the bridge.
    }
  };

  const post = (
    type,
    payload = {},
    messageId = null
  ) => {
    if (destroyed) {
      return false;
    }

    const message = {
      type,
      payload
    };

    if (messageId) {
      message.messageId = messageId;
    }

    try {
      _sendToWidget(widgetElement, message);
      return true;
    } catch (error) {
      reportError(error, message);
      return false;
    }
  };

  const sendContext = async () => {
    if (destroyed || contextSent) {
      return;
    }

    contextSent = true;

    try {
      const context = onContextReady
        ? await onContextReady()
        : {};

      post(messageTypes.CONTEXT, _safeObject(context));
    } catch (error) {
      contextSent = false;
      reportError(error, {
        type: messageTypes.CONTEXT
      });
    }
  };

  const reply = (
    type,
    payload = {},
    requestMessage = null
  ) => {
    const messageId = _getReplyMessageId(requestMessage);

    return post(type, payload, messageId);
  };

  const handleMessage = async (event) => {
    if (destroyed) {
      return;
    }

    const rawMessage = _getMessageData(event);
    const type = _getMessageType(rawMessage);
    const payload = _getPayload(rawMessage);

    if (!type) {
      return;
    }

    if (type === messageTypes.READY) {
      const status = String(
        payload?.status || ""
      ).toUpperCase();

      if (status !== "ACK") {
        post(messageTypes.READY, {
          status: "ACK"
        });
      }

      await sendContext();
      return;
    }

    if (type === messageTypes.CONTEXT) {
      return;
    }

    const replyCallback = (
      responseType,
      responsePayload
    ) => {
      return reply(
        responseType,
        responsePayload,
        rawMessage
      );
    };

    if (onMessage) {
      _safeCallback(
        onMessage,
        [rawMessage, event, replyCallback],
        reportError
      );
    }

    if (onWidgetMessage) {
      await _safeCallback(
        onWidgetMessage,
        [rawMessage, replyCallback],
        reportError
      );
    }
  };

  if (typeof widgetElement.onMessage === "function") {
    widgetListener = (event) => {
      handleMessage(event);
    };

    widgetElement.onMessage(widgetListener);
  } else {
    throw new Error(
      "widgetBridge: widget.onMessage is unavailable"
    );
  }

  const bridge = {
    postMessage(payload, type = messageTypes.CONTEXT) {
      return post(type, payload);
    },

    send(type, payload = {}, messageId = null) {
      return post(type, payload, messageId);
    },

    reply(type, payload = {}, requestMessage = null) {
      return reply(type, payload, requestMessage);
    },

    onMessage(callback) {
      if (typeof callback !== "function") {
        return () => {};
      }

      const previousCallback = onMessage;

      return () => {
        if (previousCallback === callback) {
          return;
        }
      };
    },

    destroy() {
      destroyed = true;
      widgetListener = null;
    },

    get widget() {
      return widgetElement;
    },

    get destroyed() {
      return destroyed;
    },

    get origin() {
      return WILDCARD_ORIGIN;
    },

    get type() {
      return "MM_*";
    }
  };

  post(messageTypes.READY, {
    status: "INIT"
  });

  return bridge;
}
