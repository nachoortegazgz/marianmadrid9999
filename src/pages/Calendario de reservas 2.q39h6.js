/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.8-FINAL
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 *
 * CORRECCIONES APLICADAS (v5003.8):
 *  - C1: withTimeout recibe fabrica () => promesa.
 *  - C2: loadServiceContext valida serviceId GUID y normaliza imageUrl.
 *  - C3: handleSelection extrae start y end, pasa end a resolveStaffForSlot.
 *  - C4: handleBooking fuerza serviceId/slugUrl desde currentService.
 *  - C5: Mensaje timeout correcto.
 *  - C7: reply() recibe payload como 3er argumento.
 *  - C8: Sin shadowing de message en catch.
 *  - C9: Disponibilidad separada simple vs dual.
 *  - C10: Guard currentService en AVAIL/SELECT/BOOK.
 *  - C11: Sin DEFAULT_SERVICE_IMAGE (imageUrl = "" si no hay real).
 *  - C12: Filtro de addonIds contra currentService.metadata.addons.
 *  - C13: Validacion de slotF2 en duales antes de processDualBooking.
 *  - FIX-25: Uso de currentService.serviceId (GUID validado).
 *  - FIX-26: Eliminada getResponseType (dead code).
 *  - FIX-31: G10 ASCII en strings de usuario.
 */

import wixLocation from "wix-location";
import wixWindow from "wix-window";

import {
  getServiceBySlugOrId,
  getAvailableDays,
  getAvailableSlots,
  getCertifiedDualSlots,
  resolveStaffForSlot
} from "backend/reservas.web";

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

import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web";

let currentServiceId = null;
let currentSlugUrl = null;
let currentService = null;
let bridge = null;

function parseUrlParams() {
  const query = wixLocation.query || {};

  return {
    serviceId: _safeTrim(query.serviceId || ""),
    slugUrl: _safeSlugOrId(query.slugUrl || ""),
    referral: _safeTrim(query.referral || ""),
    addonIds: _safeTrim(query.addonIds || "")
      .split(",")
      .map(_safeTrim)
      .filter(Boolean)
  };
}

function resolveServiceFromParams(params) {
  if (params.serviceId && _looksLikeGuid(params.serviceId)) {
    return {
      serviceId: params.serviceId,
      slugUrl: params.slugUrl || null
    };
  }

  if (params.slugUrl) {
    return { serviceId: null, slugUrl: params.slugUrl };
  }

  return null;
}

function getMessageType(message) {
  return String(
    (message && (message.type || message.action)) || ""
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

function createResultError(code, message) {
  return {
    status: "ERROR",
    data: null,
    error: { code, message }
  };
}

function filterAllowedAddonIds(service, requestedAddonIds) {
  if (!Array.isArray(requestedAddonIds) || requestedAddonIds.length === 0) {
    return [];
  }

  const addons = Array.isArray(service?.metadata?.addons)
    ? service.metadata.addons
    : [];

  if (addons.length === 0) return [];

  const allowed = new Set();
  for (const addon of addons) {
    const id = _safeTrim(addon?.id);
    if (id) allowed.add(id);
    const nativeId = _safeTrim(addon?.nativeId);
    if (nativeId) allowed.add(nativeId);
  }

  return requestedAddonIds
    .map((id) => _safeTrim(id))
    .filter((id) => id && allowed.has(id));
}

function getActiveServiceLookup() {
  if (currentService?.serviceId) return currentService.serviceId;
  return currentServiceId || currentSlugUrl;
}

async function loadServiceContext(params) {
  const lookup = currentServiceId || currentSlugUrl;
  const result = await getServiceBySlugOrId(lookup);

  if (
    !result ||
    result.status !== "SUCCESS" ||
    !result.data ||
    typeof result.data !== "object"
  ) {
    throw new Error(
      result?.error?.message || "No se pudo cargar el servicio."
    );
  }

  const serviceId = _safeTrim(result.data.serviceId || currentServiceId);

  if (!_looksLikeGuid(serviceId)) {
    throw new Error("El servicio no tiene un identificador valido.");
  }

  currentService = { ...result.data, serviceId };

  const metadata = result.data.metadata || {};
  const imageUrl = _safeTrim(
    result.data.imageUrl || metadata.imageUrl || ""
  );

  return {
    ...currentService,
    slugUrl: result.data.slugUrl || currentSlugUrl,
    referral: params.referral,
    preselectedAddonIds: params.addonIds,
    timeZone: "Europe/Madrid",
    currencyCode:
      result.data.currency ||
      metadata.currency ||
      metadata.pricing?.currency ||
      "EUR",
    imageUrl,
    metadata: { ...metadata, imageUrl }
  };
}

async function handleNavigation(payload) {
  const target = _safeTrim(payload?.target || "").toUpperCase();

  if (target === "SERVICIOS") {
    wixLocation.to(URLS?.SERVICIOS || "/reserva-online");
    return true;
  }

  if (target === "PRIVACY") {
    wixLocation.to(URLS?.PRIVACY_POLICY || "/politica-de-privacidad");
    return true;
  }

  return false;
}

async function handleAvailability(payload, reply) {
  if (!currentService) {
    reply(
      MESSAGE_TYPES.AVAIL,
      createResultError(
        "SERVICE_CONTEXT_NOT_READY",
        "El servicio todavia se esta cargando."
      ),
      payload
    );
    return;
  }

  const action = _safeTrim(payload.action || "").toLowerCase();
  const addonIds = filterAllowedAddonIds(
    currentService,
    Array.isArray(payload.addonIds) ? payload.addonIds : []
  );

  const timeoutMs = UI?.FRONTEND_API_TIMEOUT_MS || 60000;
  const lookup = getActiveServiceLookup();

  let result;

  try {
    if (action === "days") {
      result = await withTimeout(
        () =>
          getAvailableDays(
            lookup,
            payload.resourceId || null,
            Number(payload.year),
            Number(payload.month),
            addonIds
          ),
        timeoutMs,
        "getAvailableDays"
      );
    } else if (action === "slots") {
      if (currentService.allowCombine === true) {
        result = await withTimeout(
          () =>
            getCertifiedDualSlots(
              lookup,
              payload.resourceId || null,
              _safeTrim(payload.dateYMD || ""),
              addonIds
            ),
          timeoutMs,
          "getCertifiedDualSlots"
        );
      } else {
        result = await withTimeout(
          () =>
            getAvailableSlots(
              lookup,
              payload.resourceId || null,
              _safeTrim(payload.dateYMD || ""),
              addonIds
            ),
          timeoutMs,
          "getAvailableSlots"
        );
      }
    } else {
      result = createResultError(
        "INVALID_AVAILABILITY_REQUEST",
        "Solicitud de disponibilidad no valida."
      );
    }
  } catch (error) {
    result = createResultError(
      "AVAILABILITY_FAILED",
      error?.message || "No se pudo obtener disponibilidad."
    );
  }

  reply(
    MESSAGE_TYPES.AVAIL,
    {
      ...(result ||
        createResultError(
          "EMPTY_AVAILABILITY_RESPONSE",
          "No se recibio disponibilidad."
        )),
      requestSequence: payload.requestSequence || 0
    },
    payload
  );
}

async function handleSelection(payload, reply) {
  if (!currentService) {
    reply(
      MESSAGE_TYPES.SELECT,
      createResultError(
        "SERVICE_CONTEXT_NOT_READY",
        "El servicio todavia se esta cargando."
      ),
      payload
    );
    return;
  }

  const start = _safeTrim(
    payload.localStartDate || payload.slotF1?.localStartDate || ""
  );
  const end = _safeTrim(
    payload.localEndDate || payload.slotF1?.localEndDate || ""
  );

  if (!start || !end) {
    reply(
      MESSAGE_TYPES.SELECT,
      createResultError(
        "INVALID_SLOT",
        "El intervalo seleccionado no es valido."
      ),
      payload
    );
    return;
  }

  const addonIds = filterAllowedAddonIds(
    currentService,
    Array.isArray(payload.addonIds) ? payload.addonIds : []
  );
  const lookup = getActiveServiceLookup();

  try {
    const result = await withTimeout(
      () =>
        resolveStaffForSlot(
          lookup,
          start,
          payload.resourceId || null,
          addonIds,
          end
        ),
      UI?.FRONTEND_API_TIMEOUT_MS || 60000,
      "resolveStaffForSlot"
    );

    reply(
      MESSAGE_TYPES.SELECT,
      result ||
        createResultError(
          "STAFF_RESOLVE_FAILED",
          "No se pudo validar el profesional."
        ),
      payload
    );
  } catch (error) {
    reply(
      MESSAGE_TYPES.SELECT,
      createResultError(
        error?.code === "TIMEOUT"
          ? "STAFF_RESOLVE_TIMEOUT"
          : "STAFF_RESOLVE_FAILED",
        error?.code === "TIMEOUT"
          ? "La validacion esta tardando demasiado."
          : "No se pudo validar el profesional."
      ),
      payload
    );
  }
}

async function handleBooking(message, reply, traceId) {
  const payload = getPayload(message);

  if (!currentService) {
    reply(
      MESSAGE_TYPES.BOOK,
      createResultError(
        "SERVICE_CONTEXT_NOT_READY",
        "El servicio todavia se esta cargando."
      ),
      payload
    );
    return;
  }

  const bookingData =
    payload.bookingData && typeof payload.bookingData === "object"
      ? payload.bookingData
      : payload;

  if (!bookingData || typeof bookingData !== "object") {
    reply(
      MESSAGE_TYPES.BOOK,
      createResultError(
        "INVALID_BOOKING_PAYLOAD",
        "Los datos de la reserva no son validos."
      ),
      payload
    );
    return;
  }

  if (currentService.allowCombine === true) {
    const f2 = bookingData.slotF2;
    const f2Start = _safeTrim(f2?.localStartDate);
    const f2End = _safeTrim(f2?.localEndDate);

    if (!f2 || !f2Start || !f2End) {
      reply(
        MESSAGE_TYPES.BOOK,
        createResultError(
          "INVALID_DUAL_SLOT",
          "Falta el horario de la segunda fase."
        ),
        payload
      );
      return;
    }
  }

  const rawAddonIds = Array.isArray(bookingData.addonIds)
    ? bookingData.addonIds
    : [];
  const addonIds = filterAllowedAddonIds(currentService, rawAddonIds);

  const requestPayload = {
    ...bookingData,
    addonIds,
    serviceId: currentService.serviceId,
    slugUrl: currentService.slugUrl || currentSlugUrl,
    traceId
  };

  try {
    const result = await withTimeout(
      () => processDualBooking(requestPayload),
      UI?.FRONTEND_API_TIMEOUT_MS || 60000,
      "processDualBooking"
    );

    const bookingResult =
      result ||
      createResultError(
        "EMPTY_BOOKING_RESPONSE",
        "No se recibio respuesta de la reserva."
      );

    reply(MESSAGE_TYPES.BOOK, bookingResult, payload);

    const bookingSucceeded =
      bookingResult?.status === "SUCCESS" ||
      bookingResult?.success === true;

    if (bookingSucceeded) {
      await wixWindow.openLightbox(
        "ConfirmacionReserva",
        bookingResult.data || bookingResult
      );
    }
  } catch (error) {
    const timeout =
      error?.code === "TIMEOUT" ||
      String(error?.message || "").toUpperCase().includes("TIMEOUT");

    reply(
      MESSAGE_TYPES.BOOK,
      createResultError(
        timeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
        timeout
          ? "La reserva puede estar procesandose. No la reenvies todavia."
          : "No se pudo completar la reserva."
      ),
      payload
    );
  }
}

$w.onReady(async () => {
  const traceId = makeTraceId("calendario");
  const params = parseUrlParams();
  const resolved = resolveServiceFromParams(params);

  if (!resolved) {
    console.error("[calendario-2] Servicio no valido", { traceId });
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
    console.error("[calendario-2] Widget HTML no disponible", { traceId });
    return;
  }

  try {
    bridge = createWidgetBridge(widget, {
      onContextReady: async () => {
        return loadServiceContext(params);
      },

      onWidgetMessage: async (message, reply) => {
        const type = getMessageType(message);
        const payload = getPayload(message);

        if (type === MESSAGE_TYPES.NAV) {
          await handleNavigation(payload);
          return;
        }

        if (type === MESSAGE_TYPES.AVAIL) {
          await handleAvailability(payload, reply);
          return;
        }

        if (type === MESSAGE_TYPES.SELECT) {
          await handleSelection(payload, reply);
          return;
        }

        if (type === MESSAGE_TYPES.BOOK) {
          await handleBooking(message, reply, traceId);
          return;
        }

        if (
          type !== MESSAGE_TYPES.READY &&
          type !== MESSAGE_TYPES.CONTEXT
        ) {
          console.warn("[calendario-2] Mensaje no soportado", {
            traceId,
            type
          });
        }
      },

      onError: (error) => {
        console.error("[calendario-2] Error de comunicacion", {
          traceId,
          message: error?.message
        });
      }
    });

    if (!bridge) {
      throw new Error("No se pudo inicializar el bridge.");
    }
  } catch (error) {
    console.error("[calendario-2] Error de inicializacion", {
      traceId,
      message: error?.message
    });
  }
});
