/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.2-IMAGE-FALLBACK
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location";

import {
  MESSAGE_TYPES,
  URLS,
  UI,
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid,
  withTimeout
} from "public/mmUtils";

import {
  createWidgetBridge
} from "public/widgetBridge";

import {
  processDualBooking
} from "backend/citasManager.web";

const DEFAULT_SERVICE_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'><rect width='1200' height='800' fill='%23e9e2d9'/><circle cx='900' cy='170' r='210' fill='%23d8bea0'/><rect x='105' y='180' width='530' height='450' rx='30' fill='%23f7f3ee'/><text x='160' y='420' fill='%23342b24' font-family='Georgia' font-size='68'>MARIAN</text><text x='160' y='500' fill='%23342b24' font-family='Georgia' font-size='68'>MADRID</text></svg>";

let currentServiceId = null;
let currentSlugUrl = null;
let bridge = null;

function parseUrlParams() {
  const query = wixLocation.query || {};

  return {
    serviceId: _safeTrim(query.serviceId || ""),
    slugUrl: _safeSlugOrId(query.slugUrl || ""),
    referral: _safeTrim(query.referral || "")
  };
}

function resolveServiceFromParams(params) {
  if (
    params.serviceId &&
    _looksLikeGuid(params.serviceId)
  ) {
    return {
      serviceId: params.serviceId,
      slugUrl: params.slugUrl || null
    };
  }

  if (params.slugUrl) {
    return {
      serviceId: null,
      slugUrl: params.slugUrl
    };
  }

  return null;
}

function getMessageType(message) {
  return String(
    message &&
    (message.type || message.action) ||
    ""
  )
    .trim()
    .toUpperCase();
}

function getPayload(message) {
  if (
    message &&
    message.payload &&
    typeof message.payload === "object" &&
    !Array.isArray(message.payload)
  ) {
    return message.payload;
  }

  return {};
}

function createBookingError(code, message) {
  return {
    status: "ERROR",
    data: null,
    error: {
      code,
      message
    }
  };
}

function getNavigationTarget(payload) {
  return _safeTrim(
    payload && payload.target || ""
  ).toUpperCase();
}

function getServiceImage(context) {
  return _safeTrim(
    context?.imageUrl ||
    context?.metadata?.imageUrl ||
    context?.metadata?.mainMedia ||
    DEFAULT_SERVICE_IMAGE
  ) || DEFAULT_SERVICE_IMAGE;
}

async function handleNavigation(payload) {
  const target = getNavigationTarget(payload);

  if (target === "SERVICIOS") {
    wixLocation.to(
      URLS?.SERVICIOS || "/reserva-online"
    );

    return true;
  }

  if (target === "PRIVACY") {
    wixLocation.to(
      URLS?.PRIVACY_POLICY ||
      "/politica-de-privacidad"
    );

    return true;
  }

  return false;
}

$w.onReady(async () => {
  const traceId = makeTraceId("calendario");
  const params = parseUrlParams();
  const resolved = resolveServiceFromParams(params);

  if (!resolved) {
    console.error(
      "[calendario-2] No valid service in URL",
      { traceId }
    );
    return;
  }

  currentServiceId = resolved.serviceId;
  currentSlugUrl = resolved.slugUrl;

  const widget = $w("#htmlWidgetCalendario");

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    console.error(
      "[calendario-2] HTML widget is not available",
      { traceId }
    );
    return;
  }

  try {
    bridge = createWidgetBridge(widget, {
      slugUrl:
        currentSlugUrl ||
        currentServiceId ||
        "calendario",

      traceId,

      handshakeTimeoutMs:
        UI?.HANDSHAKE_TIMEOUT_MS || 30000,

      contextTimeoutMs:
        UI?.CONTEXT_TIMEOUT_MS || 30000,

      messageTimeoutMs:
        UI?.FRONTEND_API_TIMEOUT_MS || 30000,

      onContextReady: async () => {
        const imageUrl = DEFAULT_SERVICE_IMAGE;

        return {
          serviceId: currentServiceId,
          slugUrl: currentSlugUrl,
          referral: params.referral,
          timeZone: "Europe/Madrid",
          currencyCode: "EUR",
          imageUrl,
          metadata: {
            imageUrl
          }
        };
      },

      onWidgetMessage: async (message, reply) => {
        const type = getMessageType(message);
        const payload = getPayload(message);

        if (type === MESSAGE_TYPES.NAV) {
          await handleNavigation(payload);
          return;
        }

        if (type !== MESSAGE_TYPES.BOOK) {
          console.warn(
            "[calendario-2] Unsupported widget message",
            { traceId, type }
          );
          return;
        }

        const bookingData =
          payload.bookingData &&
          typeof payload.bookingData === "object"
            ? payload.bookingData
            : payload;

        if (
          !bookingData ||
          typeof bookingData !== "object"
        ) {
          const invalidResult = createBookingError(
            "INVALID_BOOKING_PAYLOAD",
            "Los datos de la reserva no son validos."
          );

          reply("BOOK_RES", invalidResult);
          return invalidResult;
        }

        const requestPayload = {
          ...bookingData,
          serviceId:
            bookingData.serviceId ||
            currentServiceId,
          slugUrl:
            bookingData.slugUrl ||
            currentSlugUrl,
          traceId
        };

        try {
          const result = await withTimeout(
            processDualBooking(requestPayload),
            UI?.FRONTEND_API_TIMEOUT_MS || 30000,
            "processDualBooking"
          );

          const safeResult =
            result ||
            createBookingError(
              "EMPTY_BOOKING_RESPONSE",
              "No se recibio respuesta de la reserva."
            );

          reply("BOOK_RES", safeResult);
          return safeResult;
        } catch (error) {
          const message = String(
            error?.message || ""
          );

          const isTimeout =
            error?.code === "TIMEOUT" ||
            message.toUpperCase().includes("TIMEOUT");

          const result = createBookingError(
            isTimeout
              ? "BOOKING_TIMEOUT"
              : "BOOKING_FAILED",
            isTimeout
              ? "La reserva esta tardando demasiado. Intentalo de nuevo."
              : "No se pudo completar la reserva."
          );

          console.error(
            "[calendario-2] Booking request failed",
            {
              traceId,
              code: result.error.code,
              message
            }
          );

          reply("BOOK_RES", result);
          return result;
        }
      },

      onError: (error) => {
        console.error(
          "[calendario-2] Widget bridge error",
          {
            traceId,
            message: error?.message
          }
        );
      }
    });

    if (!bridge) {
      console.error(
        "[calendario-2] Widget bridge initialization failed",
        { traceId }
      );
    }
  } catch (error) {
    console.error(
      "[calendario-2] Initialization failed",
      {
        traceId,
        message: error?.message
      }
    );
  }
});
