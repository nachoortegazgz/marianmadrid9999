/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5008.4-PUBLIC-CLEAN
RESPONSIBILITY: Shared frontend-safe utilities.
STANDARDS: G10 ASCII Strict, Velo V3 SDK.
IMPORTANT: This module must not import backend modules.
=============================================================================
*/

export const MESSAGE_TYPES = Object.freeze({
  READY: "READY",
  CONTEXT: "CONTEXT",
  NAV: "NAV",
  AVAIL: "AVAIL",
  SELECT: "SELECT",
  BOOK: "BOOK"
});

export const URLS = Object.freeze({
  SERVICIOS: "/reserva-online",
  CALENDARIO_2: "/booking-calendar/calendario-2",
  PRIVACY_POLICY: "/politica-de-privacidad"
});

export const UI = Object.freeze({
  FRONTEND_API_TIMEOUT_MS: 60000,
  HANDSHAKE_TIMEOUT_MS: 15000,
  CONTEXT_TIMEOUT_MS: 30000
});

export function _safeTrim(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

export function _safeSlugOrId(value) {
  return _safeTrim(value)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

export function _looksLikeGuid(value) {
  const clean = _safeTrim(value);

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    clean
  );
}

export function makeTraceId(prefix = "trace") {
  const cleanPrefix =
    _safeTrim(prefix).replace(/[^a-zA-Z0-9_-]/g, "") || "trace";

  const timestamp = Date.now().toString(36);
  const randomPart = Math.random()
    .toString(36)
    .slice(2, 10);

  return `${cleanPrefix}-${timestamp}-${randomPart}`;
}

export function withTimeout(
  promiseFactory,
  timeoutMs = 60000,
  operation = "operation"
) {
  if (typeof promiseFactory !== "function") {
    return Promise.reject(
      new Error("TIMEOUT_INVALID_PROMISE_FACTORY")
    );
  }

  const duration = Number(timeoutMs);

  if (!Number.isFinite(duration) || duration <= 0) {
    return Promise.resolve().then(() => promiseFactory());
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;

      const error = new Error(
        `Timeout en ${_safeTrim(operation) || "operation"}`
      );

      error.code = "TIMEOUT";
      reject(error);
    }, duration);

    Promise.resolve()
      .then(() => promiseFactory())
      .then((result) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function _roundMoney(value, decimals = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  const places = Number.isInteger(decimals)
    ? Math.max(0, decimals)
    : 2;

  const factor = 10 ** places;

  return Math.round((number + Number.EPSILON) * factor) / factor;
}

export function _maskEmail(value) {
  const email = _safeTrim(value);
  const atIndex = email.indexOf("@");

  if (atIndex <= 0) {
    return email ? "***" : "";
  }

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (local.length <= 2) {
    return `***@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

export function _maskPhone(value) {
  const phone = _safeTrim(value);

  if (!phone) {
    return "";
  }

  const visible = phone.slice(-3);

  return `***${visible}`;
}

export function _maskName(value) {
  const name = _safeTrim(value);

  if (!name) {
    return "";
  }

  const parts = name.split(/\s+/);

  return parts
    .map((part) => {
      if (part.length <= 1) {
        return "*";
      }

      return `${part[0]}***`;
    })
    .join(" ");
}

export function _cloneDeep(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (error) {
      void error;
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => _cloneDeep(item));
  }

  if (typeof value === "object") {
    const result = {};

    Object.keys(value).forEach((key) => {
      result[key] = _cloneDeep(value[key]);
    });

    return result;
  }

  return value;
}

export function _stableSerialize(value) {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(_stableSerialize).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${_stableSerialize(value[key])}`;
      })
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function _normalizeLocalIsoStr(value) {
  const clean = _safeTrim(value);

  if (!clean) {
    return "";
  }

  return clean
    .replace(" ", "T")
    .replace(/([+-]\d{2}:\d{2}|Z)$/, "");
}

export function getUtcDateFromMadridLocal(value) {
  const clean = _normalizeLocalIsoStr(value);

  if (!clean) {
    return null;
  }

  const match = clean.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  const milliseconds = Number(
    String(match[7] || "0").padEnd(3, "0")
  );

  const utcBase = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    milliseconds
  );

  if (!Number.isFinite(utcBase)) {
    return null;
  }

  let offsetMinutes = 60;

  const march31 = new Date(Date.UTC(year, 2, 31));
  const lastSundayMarch =
    31 - march31.getUTCDay();

  const october31 = new Date(Date.UTC(year, 9, 31));
  const lastSundayOctober =
    31 - october31.getUTCDay();

  const summerStart = Date.UTC(
    year,
    2,
    lastSundayMarch,
    1,
    0,
    0,
    0
  );

  const summerEnd = Date.UTC(
    year,
    9,
    lastSundayOctober,
    1,
    0,
    0,
    0
  );

  if (utcBase >= summerStart && utcBase < summerEnd) {
    offsetMinutes = 120;
  }

  return new Date(utcBase - offsetMinutes * 60000);
}

export function computeGapMinutes(f1EndUtc, f2StartUtc) {
  if (
    !(f1EndUtc instanceof Date) ||
    !(f2StartUtc instanceof Date)
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.round(
      (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000
    )
  );
}

export function toUtcRange(startLocal, endLocal) {
  const startUtc = getUtcDateFromMadridLocal(startLocal);
  const endUtc = getUtcDateFromMadridLocal(endLocal);

  if (!startUtc || !endUtc) {
    return null;
  }

  if (endUtc.getTime() <= startUtc.getTime()) {
    return null;
  }

  return {
    startUtc,
    endUtc
  };
}
