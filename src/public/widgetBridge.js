/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5007.4-FINAL
RESPONSIBILITY: Comunicacion segura entre la pagina y widgets embebidos.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

const DEFAULT_MESSAGE_TYPE = "MM_WIDGET";
const WILDCARD_ORIGIN = "*";

// =============================================================================
// HELPERS
// =============================================================================

function _isWindowTarget(target) {
    return (
        target &&
        typeof target.postMessage === "function"
    );
}

function _normalizeMessageType(value) {
    return typeof value === "string" && value.trim() ?
        value.trim() :
        DEFAULT_MESSAGE_TYPE;
}

function _normalizeAllowedOrigin(value) {
    if (value === undefined || value === null || value === "") {
        return WILDCARD_ORIGIN;
    }

    if (typeof value !== "string") {
        throw new TypeError("allowedOrigin must be a string");
    }

    const origin = value.trim();

    if (origin === WILDCARD_ORIGIN) {
        return WILDCARD_ORIGIN;
    }

    try {
        return new URL(origin).origin;
    } catch {
        throw new TypeError("allowedOrigin must be a valid origin");
    }
}

function _getMessageTarget(widgetElement) {
    return widgetElement?.contentWindow || widgetElement;
}

// =============================================================================
// PUBLIC API
// =============================================================================

export function createWidgetBridge(widgetElement, options = {}) {
    if (!widgetElement) {
        throw new Error("widgetBridge: widgetElement is required");
    }

    const {
        onMessage = null,
            onError = null,
            messageType = DEFAULT_MESSAGE_TYPE,
    } = options;

    const allowedOrigin = _normalizeAllowedOrigin(
        options.allowedOrigin
    );

    if (onMessage !== null && typeof onMessage !== "function") {
        throw new TypeError("onMessage must be a function");
    }

    if (onError !== null && typeof onError !== "function") {
        throw new TypeError("onError must be a function");
    }

    const normalizedMessageType = _normalizeMessageType(messageType);
    let destroyed = false;

    const reportError = (error, context) => {
        if (typeof onError !== "function") {
            return;
        }

        try {
            onError(error, context);
        } catch {
            // Errors from the consumer callback must not break the bridge.
        }
    };

    const messageHandler = (event) => {
        if (destroyed) {
            return;
        }

        if (
            allowedOrigin !== WILDCARD_ORIGIN &&
            event.origin !== allowedOrigin
        ) {
            return;
        }

        const data = event.data;

        if (
            !data ||
            typeof data !== "object" ||
            data.type !== normalizedMessageType
        ) {
            return;
        }

        if (typeof onMessage !== "function") {
            return;
        }

        try {
            onMessage(data.payload, event);
        } catch (error) {
            reportError(error, data);
        }
    };

    if (
        typeof window === "undefined" ||
        typeof window.addEventListener !== "function"
    ) {
        throw new Error("widgetBridge: window messaging is unavailable");
    }

    window.addEventListener("message", messageHandler);

    return {
        postMessage(payload) {
            if (destroyed) {
                const error = new Error(
                    "widgetBridge: bridge has been destroyed"
                );

                reportError(error, payload);
                return false;
            }

            const target = _getMessageTarget(widgetElement);

            if (!_isWindowTarget(target)) {
                const error = new Error(
                    "widgetBridge: widget target does not support postMessage"
                );

                reportError(error, payload);
                return false;
            }

            try {
                target.postMessage({
                        type: normalizedMessageType,
                        payload,
                    },
                    allowedOrigin
                );

                return true;
            } catch (error) {
                reportError(error, payload);
                return false;
            }
        },

        destroy() {
            if (destroyed) {
                return;
            }

            destroyed = true;
            window.removeEventListener("message", messageHandler);
        },

        get widget() {
            return widgetElement;
        },

        get destroyed() {
            return destroyed;
        },

        get origin() {
            return allowedOrigin;
        },

        get type() {
            return normalizedMessageType;
        },
    };
}