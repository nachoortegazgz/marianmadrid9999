/*
=============================================================================
MODULE: public/marianAdministrationController.js
VERSION: v5010-CLEAN
RESPONSIBILITY: Public administration message routing.
CONTRACT: widgetBridge uses onWidgetMessage(message, bridge).
=============================================================================
*/

import { createWidgetBridge } from "public/widgetBridge";

const ADMIN_MESSAGE_TYPE = "MM_ADMIN";
const ADMIN_RESPONSE_TYPE = "MM_ADMIN_RESPONSE";

const ADMIN_ACTION_DISPATCH = Object.freeze({
    GET_CASHIER_STATE: "getCashierState",
    REGISTER_MANUAL_TX: "registerManualTransaction",
    REGISTER_X_COUNT: "registerXCount",
    REGISTER_Z_CLOSING: "registerZClosing",
    VERIFY_HASH_CHAIN: "verifyFiscalHashChainIntegrity",
    GET_INVENTORY_DASHBOARD: "getInventoryDashboard",
    GET_RECONCILIATION_QUEUE: "getInventoryReconciliationQueue",
    GET_STAFF_CONTEXT: "getMyStaffContext",
    REGISTER_FICHAJE: "registrarFichaje",
    GET_JORNADA_STATE: "getEstadoJornada",
    CHECK_ADMIN_ACCESS: "checkAdminAccess",
    CHECK_CAJERO_ACCESS: "checkCajeroAccess",
    GET_FISCAL_REPORT: "generateLibroIVAExpedidas",
    GET_Z_CLOSING_REPORT: "generateCierreZReport",
});

function _postError(post, messageId, message, code) {
    if (typeof post !== "function") {
        return;
    }

    try {
        post({
            type: ADMIN_RESPONSE_TYPE,
            messageId,
            status: "ERROR",
            error: {
                code: code || "UNKNOWN",
                message: message || "Unknown error",
            },
        });
    } catch (error) {
        void error;
    }
}

function _messageId(value) {
    const normalized = String(value || "").trim();
    return normalized || `msg_${Date.now()}`;
}

export function initMarianAdministration(widget, _slug) {
    if (!widget) {
        throw new Error("initMarianAdministration: widget is required");
    }

    const bridge = createWidgetBridge(widget, {
        allowedTypes: [ADMIN_MESSAGE_TYPE, ADMIN_RESPONSE_TYPE],
        onWidgetMessage: (message, currentBridge) => {
            const action = message?.payload?.action || message?.action;
            const messageId = _messageId(
                message?.messageId || message?.payload?.messageId
            );

            if (!action || !ADMIN_ACTION_DISPATCH[action]) {
                _postError(
                    currentBridge?.send
                        ? (payload) => currentBridge.send(ADMIN_RESPONSE_TYPE, payload, messageId)
                        : null,
                    messageId,
                    `Unknown action: ${action}`,
                    "UNKNOWN_ACTION"
                );
                return;
            }

            try {
                currentBridge.send(
                    ADMIN_RESPONSE_TYPE,
                    {
                        messageId,
                        status: "DISPATCHED",
                        action,
                        targetMethod: ADMIN_ACTION_DISPATCH[action],
                        params: message?.payload?.params || message?.params || {},
                    },
                    messageId
                );
            } catch (error) {
                _postError(
                    currentBridge?.send
                        ? (payload) => currentBridge.send(ADMIN_RESPONSE_TYPE, payload, messageId)
                        : null,
                    messageId,
                    error?.message || "Dispatch failed",
                    "DISPATCH_FAIL"
                );
            }
        },
        onError: (_error, _data) => {},
    });

    return {
        bridge,
        destroy: () => bridge.destroy(),
    };
}
