/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5009-FISCAL-V20.1
BASE: v5008.4-PUBLIC-CLEAN + revision revisada
RESPONSIBILITY: Shared frontend-safe utilities.
STANDARDS: G10 ASCII Strict, Velo V3 SDK.
IMPORTANT: This module must not import backend modules.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: cabecera actualizada.
  - V20-02: revisada la implementacion de _safeTrim, _looksLikeGuid,
            cleanGuid, cleanGuidList, numberOrZero, _roundMoney,
            booleanValue, _cleanText, _normalizeIdPart,
            _normalizeLocalIsoStr, getUtcDateFromMadridLocal, toUtcRange,
            computeGapMinutes, readDurationRange, resolveExpectedSlotMinutes,
            validateSlotDuration, _cloneDeep, _maskEmail, _maskPhone,
            _maskName, makeTraceId, isPlainObject, withTimeout.
  - V20-03: reintegrados MESSAGE_TYPES, URLS, UI (consumidos por
            calendario-2.js y servicio-2.js).
  - V20-04: reintegrados _safeSlugOrId, _stableSerialize, _executeWithRetry,
            _toDateSafe, _hashKey, _readDate, _readPositiveAmount,
            _generateUUID, getMadridLocalStringNoZ (importados por backend).
  - V20-05: getUtcDateFromMadridLocal ahora espera offset explicito en el
            input. Si el caller no lo envia, el runtime usa su TZ local.
            Los modulos backend que lo invocan deben enviar offset Madrid
            o una fecha ISO ya interpretable.

NOTA DE DUPLICACION: readDurationRange, resolveExpectedSlotMinutes,
toUtcRange, computeGapMinutes y validateSlotDuration viven tambien en
backend/booking/bookingUtils.js. Se recomienda que bookingUtils reexporte
desde aqui en v5010 para eliminar la duplicacion.
=============================================================================
*/

// =============================================================================
// CONSTANTES DE PROTOCOLO
// =============================================================================

export const MESSAGE_TYPES = Object.freeze({
  READY: "READY",
  CONTEXT: "CONTEXT",
  NAV: "NAV",
  AVAIL: "AVAIL",
  SELECT: "SELECT",
  BOOK: "BOOK",
});

export const URLS = Object.freeze({
  SERVICIOS: "/reserva-online",
  CALENDARIO_2: "/booking-calendar/calendario-2",
  PRIVACY_POLICY: "/politica-de-privacidad",
});

export const UI = Object.freeze({
  FRONTEND_API_TIMEOUT_MS: 60000,
  HANDSHAKE_TIMEOUT_MS: 15000,
  CONTEXT_TIMEOUT_MS: 30000,
});

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 5000;
const MADRID_TIME_ZONE = "Europe/Madrid";

// =============================================================================
// TEXTO
// =============================================================================

export function _safeTrim(value, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .slice(0, Math.max(1, Number(maxLength) || MAX_TEXT_LENGTH));
}

export function _cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return _safeTrim(value, maxLength).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    ""
  );
}

export function _normalizeIdPart(value, maxLength = 200) {
  return _cleanText(value, maxLength).replace(/[^a-zA-Z0-9._:-]/g, "_");
}

export function _safeSlugOrId(value) {
  return _safeTrim(value, 200)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

// =============================================================================
// GUID
// =============================================================================

export function _looksLikeGuid(value) {
  return GUID_PATTERN.test(_safeTrim(value, 100));
}

export function isGuid(value) {
  return _looksLikeGuid(value);
}

export function cleanGuid(value, errorCode = "INVALID_GUID") {
  const clean = _safeTrim(value, 100);
  if (!_looksLikeGuid(clean)) {
    const error = new Error(`${errorCode}: GUID invalido o ausente`);
    error.code = errorCode;
    throw error;
  }
  return clean;
}

export function cleanGuidList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  return [
    ...new Set(
      source
        .map((item) => {
          if (typeof item === "string") return _safeTrim(item, 100);
          return _safeTrim(item?.resourceId || item?.id || item?._id, 100);
        })
        .filter(_looksLikeGuid)
    ),
  ];
}

// =============================================================================
// NUMEROS
// =============================================================================

export function numberOrZero(value, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : 0;
}

export function _roundMoney(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** Math.max(0, Number(decimals) || 2);
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

export function booleanValue(...values) {
  return values.some((value) => value === true);
}

export function _readPositiveAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// =============================================================================
// FECHAS
// =============================================================================

export function _normalizeLocalIsoStr(value) {
  const raw = _safeTrim(value, 80);
  if (!raw) return "";
  return raw.replace(" ", "T");
}

function parseDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const raw = _normalizeLocalIsoStr(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getUtcDateFromMadridLocal(value) {
  const date = parseDate(value);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function getMadridLocalStringNoZ(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";

  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: MADRID_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(dt)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function _toDateSafe(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function _readDate(value) {
  const clean = _safeTrim(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const dt = _toDateSafe(value);
  if (!dt) return null;
  return dt.toLocaleDateString("sv-SE", { timeZone: MADRID_TIME_ZONE });
}

export function toUtcRange(startLocal, endLocal) {
  const startUtc = getUtcDateFromMadridLocal(startLocal);
  const endUtc = getUtcDateFromMadridLocal(endLocal);
  if (!startUtc || !endUtc || endUtc <= startUtc) return null;
  return { startUtc, endUtc };
}

export function computeGapMinutes(firstEndUtc, secondStartUtc) {
  if (!(firstEndUtc instanceof Date) || !(secondStartUtc instanceof Date)) {
    return 0;
  }
  return Math.max(
    0,
    Math.round((secondStartUtc.getTime() - firstEndUtc.getTime()) / 60000)
  );
}

// =============================================================================
// DURACION
// =============================================================================

export function readDurationRange(item = {}) {
  const constraints =
    item.availabilityConstraints ||
    item.data?.availabilityConstraints ||
    item.fields?.availabilityConstraints;

  const range =
    constraints?.durationRange ||
    item.durationRange ||
    item.data?.durationRange ||
    item.fields?.durationRange;

  if (!range || typeof range !== "object") return null;

  const min = numberOrZero(range.minDuration ?? range.min);
  const rawMax = numberOrZero(range.maxDuration ?? range.max);
  const max = rawMax > 0 ? rawMax : Infinity;

  if (min <= 0 && max === Infinity) return null;
  if (max !== Infinity && max <= min) return null;

  return { min, max };
}

export function resolveExpectedSlotMinutes(serviceConfig = {}) {
  if (serviceConfig.allowCombine === true) {
    return numberOrZero(serviceConfig.phase1Duration);
  }
  return numberOrZero(
    serviceConfig.phase1Duration ||
      serviceConfig.totalDuration ||
      serviceConfig.metadata?.timing?.estimatedTotal
  );
}

export function validateSlotDuration({
  serviceConfig = {},
  startLocal,
  endLocal,
} = {}) {
  const result = {
    ok: true,
    code: null,
    actualMinutes: 0,
    expectedMinutes: null,
    min: null,
    max: null,
  };

  const range = toUtcRange(startLocal, endLocal);
  if (!range) return { ...result, ok: false, code: "INVALID_SLOT_RANGE" };

  result.actualMinutes = Math.round(
    (range.endUtc - range.startUtc) / 60000
  );

  const limits = readDurationRange(serviceConfig);
  if (limits) {
    result.min = limits.min;
    result.max = limits.max === Infinity ? null : limits.max;
    if (
      result.actualMinutes < limits.min ||
      (limits.max !== Infinity && result.actualMinutes > limits.max)
    ) {
      return { ...result, ok: false, code: "SLOT_DURATION_OUT_OF_RANGE" };
    }
    return result;
  }

  const expected = resolveExpectedSlotMinutes(serviceConfig);
  if (expected > 0) {
    result.expectedMinutes = expected;
    if (Math.abs(result.actualMinutes - expected) > 1) {
      return { ...result, ok: false, code: "SLOT_DURATION_MISMATCH" };
    }
  }

  return result;
}

// =============================================================================
// OBJETOS
// =============================================================================

export function _cloneDeep(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(_cloneDeep);

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = _cloneDeep(child);
  }
  return result;
}

export function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
  );
}

export function _stableSerialize(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(_stableSerialize).join(",")}]`;
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// =============================================================================
// PII MASK
// =============================================================================

export function _maskEmail(value) {
  const email = _safeTrim(value, 254);
  const at = email.indexOf("@");
  if (at <= 1) return "[REDACTED_EMAIL]";
  return `${email[0]}***${email.slice(at - 1)}`;
}

export function _maskPhone(value) {
  const phone = _safeTrim(value, 40);
  return phone.length > 4 ? `***${phone.slice(-4)}` : "[REDACTED_PHONE]";
}

export function _maskName(value) {
  const name = _safeTrim(value, 120);
  return name ? `${name[0]}***` : "[REDACTED_NAME]";
}

// =============================================================================
// IDs
// =============================================================================

export function makeTraceId(prefix = "trace") {
  const safePrefix = _normalizeIdPart(prefix, 40) || "trace";
  const random = Math.random().toString(36).slice(2, 10);
  return `${safePrefix}-${Date.now().toString(36)}-${random}`;
}

export function _generateUUID() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch (_) {
      // fallthrough
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function _hashKey(value) {
  const str = String(value || "");
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}

// =============================================================================
// ASYNC
// =============================================================================

export function withTimeout(promiseOrFactory, timeoutMs, label = "OPERATION_TIMEOUT") {
  const factory =
    typeof promiseOrFactory === "function"
      ? promiseOrFactory
      : () => promiseOrFactory;

  const timeout = Math.max(1, Number(timeoutMs) || 15000);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(label);
      error.code = "TIMEOUT";
      reject(error);
    }, timeout);

    Promise.resolve()
      .then(factory)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function _executeWithRetry(fn, maxRetries = 2, delayMs = 300) {
  let lastError;
  const retries = Math.max(0, Number(maxRetries) || 0);
  const baseDelay = Math.max(0, Number(delayMs) || 0);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const wait = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  throw lastError;
}