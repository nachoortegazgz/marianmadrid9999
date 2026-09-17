/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5007.4-FINAL
CORRECTIONS: MMU-01 a MMU-20
=============================================================================
*/

const MADRID_TZ = "Europe/Madrid";
const ZERO_HASH = "0".repeat(64);
const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =============================================================================
// IDENTIFICADORES
// =============================================================================

export function makeTraceId(prefix = "op") {
    const rawPrefix =
        typeof prefix === "string" && prefix.length > 0 ? prefix : "op";

    const safePrefix =
        rawPrefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "op";

    return `${safePrefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 11)}`;
}

export function _generateUUID() {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }

    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
        /[xy]/g,
        (character) => {
            const randomValue = Math.floor(Math.random() * 16);
            const value =
                character === "x" ?
                randomValue :
                (randomValue & 0x3) | 0x8;

            return value.toString(16);
        }
    );
}

// =============================================================================
// TEXTO E IDENTIFICADORES
// =============================================================================

export function _safeTrim(value) {
    if (value === null || value === undefined) {
        return "";
    }

    try {
        return String(value).trim();
    } catch {
        return "";
    }
}

export function _cleanText(value, maxLength = 500) {
    const text = _safeTrim(value);

    if (!text) {
        return "";
    }

    const safeLength =
        Number.isFinite(maxLength) && maxLength > 0 ?
        Math.floor(maxLength) :
        500;

    return text.replace(/\s+/g, " ").slice(0, safeLength);
}

export function _safeSlugOrId(value) {
    const text = _safeTrim(value);

    if (!text) {
        return "";
    }

    return text
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120);
}

export function _normType(type) {
    return _safeTrim(type).toUpperCase();
}

export function _looksLikeGuid(value) {
    return (
        typeof value === "string" &&
        GUID_PATTERN.test(value.trim())
    );
}

export function normalizeIdPart(value, maxLength = 100) {
    const text = _safeTrim(value);

    if (!text) {
        return "";
    }

    const safeLength =
        Number.isFinite(maxLength) && maxLength > 0 ?
        Math.floor(maxLength) :
        100;

    return text
        .replace(/[^a-zA-Z0-9_.-]/g, "")
        .slice(0, safeLength);
}

export const _normalizeIdPart = normalizeIdPart;

// =============================================================================
// EMAIL, TELEFONO Y RELACIONES
// =============================================================================

export function _isValidEmail(email) {
    const value = _safeTrim(email);

    if (!value || value.length > 254) {
        return false;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function _safeEmail(email) {
    const value = _safeTrim(email);

    return _isValidEmail(value) ? value.toLowerCase() : "";
}

export function _safePhone(phone) {
    const value = _safeTrim(phone);

    if (!value) {
        return "";
    }

    return value.replace(/\s+/g, "").replace(/[^\d+]/g, "");
}

export function _extractRelationalId(value) {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "string") {
        return _safeTrim(value);
    }

    if (typeof value === "object") {
        return _safeTrim(value._id || value.id || value.itemId);
    }

    return "";
}

// =============================================================================
// DINERO
// =============================================================================

export function _roundMoney(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return 0;
    }

    return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function _readPositiveAmount(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    return _roundMoney(amount);
}

export function _readNonNegativeAmount(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount < 0) {
        return null;
    }

    return _roundMoney(amount);
}

// =============================================================================
// FECHAS
// =============================================================================

export function _toDateSafe(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value);

        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value === "string") {
        const text = value.trim();

        if (!text) {
            return null;
        }

        const date = new Date(text);

        return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
}

export function _readDate(value) {
    const date = _toDateSafe(value);

    if (!date) {
        return null;
    }

    try {
        return date.toLocaleDateString("sv-SE", {
            timeZone: MADRID_TZ,
        });
    } catch {
        return null;
    }
}

function _formatMadridDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: MADRID_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(date);

    const get = (type) =>
        parts.find((part) => part.type === type)?.value || "";

    let hour = get("hour");

    if (hour === "24") {
        hour = "00";
    }

    return {
        year: get("year"),
        month: get("month"),
        day: get("day"),
        hour: hour.padStart(2, "0"),
        minute: get("minute").padStart(2, "0"),
        second: get("second").padStart(2, "0"),
    };
}

function _isValidLocalDateTime(year, month, day, hour, minute, second) {
    const date = new Date(
        Date.UTC(year, month - 1, day, hour, minute, second)
    );

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day &&
        date.getUTCHours() === hour &&
        date.getUTCMinutes() === minute &&
        date.getUTCSeconds() === second
    );
}

export function _normalizeLocalIsoStr(value) {
    const text = _safeTrim(value);

    if (!text) {
        return "";
    }

    const localMatch =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(
            text
        );

    if (localMatch) {
        const year = Number(localMatch[1]);
        const month = Number(localMatch[2]);
        const day = Number(localMatch[3]);
        const hour = Number(localMatch[4]);
        const minute = Number(localMatch[5]);
        const second = Number(localMatch[6]);

        if (
            !_isValidLocalDateTime(
                year,
                month,
                day,
                hour,
                minute,
                second
            )
        ) {
            return "";
        }

        return `${String(year).padStart(4, "0")}-${String(month).padStart(
      2,
      "0"
    )}-${String(day).padStart(2, "0")}T${String(hour).padStart(
      2,
      "0"
    )}:${String(minute).padStart(2, "0")}:${String(second).padStart(
      2,
      "0"
    )}`;
    }

    const date = _toDateSafe(text);

    if (!date) {
        return "";
    }

    try {
        const parts = _formatMadridDateParts(date);

        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
        return "";
    }
}

export function getUtcDateFromMadridLocal(localValue) {
    const normalized = _normalizeLocalIsoStr(localValue);

    if (!normalized) {
        return null;
    }

    const [datePart, timePart] = normalized.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute, second] = timePart.split(":").map(Number);

    const targetUtc = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second
    );

    let guess = new Date(targetUtc);

    for (let index = 0; index < 4; index += 1) {
        const parts = _formatMadridDateParts(guess);

        const madridAsUtc = Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute),
            Number(parts.second)
        );

        const difference = targetUtc - madridAsUtc;

        if (Math.abs(difference) < 1000) {
            break;
        }

        guess = new Date(guess.getTime() + difference);
    }

    return guess;
}

export function getMadridLocalStringNoZ(value) {
    const date = _toDateSafe(value);

    if (!date) {
        return "";
    }

    try {
        const parts = _formatMadridDateParts(date);

        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
        return "";
    }
}

// =============================================================================
// SERIALIZACION Y HASH DE CLAVES
// =============================================================================

export function _stableSerialize(value) {
    const seen = new WeakSet();

    function serialize(current) {
        if (current === null || current === undefined) {
            return "null";
        }

        if (typeof current === "string") {
            return JSON.stringify(current);
        }

        if (
            typeof current === "number" ||
            typeof current === "boolean"
        ) {
            return JSON.stringify(current);
        }

        if (typeof current === "bigint") {
            return JSON.stringify(`${current}n`);
        }

        if (typeof current !== "object") {
            return "null";
        }

        if (seen.has(current)) {
            return JSON.stringify("[Circular]");
        }

        seen.add(current);

        if (current instanceof Date) {
            return JSON.stringify(current.toISOString());
        }

        if (Array.isArray(current)) {
            return `[${current.map((item) => serialize(item)).join(",")}]`;
        }

        const keys = Object.keys(current).sort();

        return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(current[key])}`
      )
      .join(",")}}`;
    }

    return serialize(value);
}

export function _hashKey(input) {
    const text = _safeTrim(input);

    if (!text) {
        return ZERO_HASH;
    }

    let hash1 = 0xdeadbeef;
    let hash2 = 0x41c6ce57;

    for (let index = 0; index < text.length; index += 1) {
        const character = text.charCodeAt(index);

        hash1 = Math.imul(hash1 ^ character, 2654435761);
        hash2 = Math.imul(hash2 ^ character, 1597334677);
    }

    hash1 = Math.imul(hash1 ^ (hash1 >>> 16), 2246822507);
    hash1 ^= Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);

    hash2 = Math.imul(hash2 ^ (hash2 >>> 16), 2246822507);
    hash2 ^= Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);

    const combined =
        4294967296 * (2097151 & hash2) + (hash1 >>> 0);

    return combined
        .toString(16)
        .padStart(16, "0")
        .repeat(4)
        .slice(0, 64);
}

// =============================================================================
// PROTECCION DE DATOS
// =============================================================================

export function _maskEmail(email) {
    const value = _safeTrim(email);
    const separatorIndex = value.indexOf("@");

    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        return "";
    }

    const local = value.slice(0, separatorIndex);
    const domain = value.slice(separatorIndex + 1);

    return `${local.charAt(0)}${"*".repeat(
    Math.max(3, local.length - 1)
  )}@${domain}`;
}

export function _maskPhone(phone) {
    const value = _safeTrim(phone).replace(/\s+/g, "");

    if (value.length < 4) {
        return "";
    }

    return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

export function _maskName(name) {
    const value = _safeTrim(name);

    if (!value) {
        return "";
    }

    return value
        .split(/\s+/)
        .map((word) =>
            word.length <= 1 ?
            word :
            `${word.charAt(0)}${"*".repeat(word.length - 1)}`
        )
        .join(" ");
}

export function _maskIp(ip) {
    const value = _safeTrim(ip);

    if (!value) {
        return "";
    }

    const parts = value.split(".");

    if (parts.length !== 4) {
        return value;
    }

    return `${parts[0]}.${parts[1]}.*.*`;
}

// =============================================================================
// ASINCRONIA
// =============================================================================

export function withTimeout(promise, timeoutMs, label = "operation") {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `TIMEOUT: ${label} exceeded ${timeoutMs}ms`
                )
            );
        }, timeoutMs);

        Promise.resolve(promise).then(
            (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

export async function _executeWithRetry(
    operation,
    retries = 3,
    baseDelayMs = 500
) {
    if (typeof operation !== "function") {
        throw new TypeError("operation must be a function");
    }

    const safeRetries = Math.max(0, Math.floor(Number(retries) || 0));
    const safeBaseDelay = Math.max(
        0,
        Number(baseDelayMs) || 0
    );

    let lastError;

    for (let attempt = 0; attempt <= safeRetries; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;

            if (attempt >= safeRetries) {
                break;
            }

            const delay = Math.min(
                safeBaseDelay * 2 ** attempt +
                Math.random() * safeBaseDelay,
                30000
            );

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

// =============================================================================
// CLONADO
// =============================================================================

export function _cloneDeep(value) {
    const seen = new WeakMap();

    function clone(current) {
        if (current === null || typeof current !== "object") {
            return current;
        }

        if (current instanceof Date) {
            return new Date(current.getTime());
        }

        if (current instanceof RegExp) {
            return new RegExp(current.source, current.flags);
        }

        if (seen.has(current)) {
            return seen.get(current);
        }

        if (current instanceof Map) {
            const clonedMap = new Map();
            seen.set(current, clonedMap);

            current.forEach((mapValue, mapKey) => {
                clonedMap.set(clone(mapKey), clone(mapValue));
            });

            return clonedMap;
        }

        if (current instanceof Set) {
            const clonedSet = new Set();
            seen.set(current, clonedSet);

            current.forEach((setValue) => {
                clonedSet.add(clone(setValue));
            });

            return clonedSet;
        }

        if (Array.isArray(current)) {
            const clonedArray = [];
            seen.set(current, clonedArray);

            current.forEach((item, index) => {
                clonedArray[index] = clone(item);
            });

            return clonedArray;
        }

        const clonedObject = {};
        seen.set(current, clonedObject);

        Object.keys(current).forEach((key) => {
            clonedObject[key] = clone(current[key]);
        });

        return clonedObject;
    }

    return clone(value);
}

// =============================================================================
// EXPORT DEFAULT
// =============================================================================

export default {
    makeTraceId,
    _generateUUID,
    _safeTrim,
    _cleanText,
    _safeSlugOrId,
    _normType,
    _looksLikeGuid,
    _isValidEmail,
    _extractRelationalId,
    _roundMoney,
    _readPositiveAmount,
    _readNonNegativeAmount,
    _toDateSafe,
    _readDate,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _stableSerialize,
    _hashKey,
    _maskEmail,
    _maskPhone,
    _maskName,
    _maskIp,
    _safeEmail,
    _safePhone,
    withTimeout,
    _executeWithRetry,
    _cloneDeep,
    normalizeIdPart,
    _normalizeIdPart,
};