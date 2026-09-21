/*
=============================================================================
MODULE: backend/logger.js
VERSION: v5009.0-FISCAL
CORRECTIONS: LOG-01 sin global, LOG-03 PII recursiva con enmascarado real,
             LOG-04 spread context ya no puede sobrescribir level/message,
             LOG-05 contactDetails/contact se sanitizan recursivamente,
             LOG-06 errorWithStack sanea stack + code en child,
             LOG-07 SECRET_FIELD_NAMES/PII_FIELD_NAMES limpiados,
             LOG-08 context no-objeto se normaliza a {}.
FIXES APLICADOS v5007.4 (heredados):
  - FIX-44: import de mmUtils via alias "public/mmUtils" en lugar de ruta
            relativa. Evita fallo de resolucion en el bundler de Velo.
  - FIX-45: sanitizeValue limpia el WeakSet tras procesar cada nodo,
            evitando falsos positivos [Circular] en objetos referenciados
            dos veces en ramas distintas (no ciclicas).
=============================================================================
*/
import { makeTraceId, _maskEmail, _maskPhone, _maskName } from "public/mmUtils";

export const LOG_LEVELS = Object.freeze({ DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 });
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

// [LOG-07] Sets normalizados: las claves se comparan contra lowerKey con
// separadores eliminados (-, _, espacio). Por eso NO se incluyen variantes
// con guion o underscore: ya no coinciden nunca y confunden.
const SECRET_FIELD_NAMES = new Set([
    "password", "secret", "token", "apikey", "authorization",
    "auth", "bearer", "cookie", "sessionid", "fiscalkey", "hmac",
    "signature", "creditcard", "cardnumber", "cvv", "pin",
]);

const PII_FIELD_NAMES = new Set([
    "email", "phone", "firstname", "lastname", "name",
    "contactdetails", "contact", "address", "ip", "ipaddress",
    "telefono", "correo", 'name', "apellidos",
]);

// [LOG-08] Normaliza cualquier valor no-objeto a un objeto seguro.
function _asObject(value) {
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) return {};
    return value;
}

// [LOG-06] Sanea stack traces eliminando rutas absolutas de usuario.
function _sanitizeStack(stack) {
    if (typeof stack !== "string") return stack;
    return stack
        .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
        .replace(/\/home\/[^/\s]+/g, "/home/[REDACTED]")
        .replace(/[A-Z]:\\Users\\[^\\\s]+/g, "C:\\Users\\[REDACTED]");
}

// [LOG-05] Aplica el enmascarado adecuado segun la clave.
function _maskByKey(lowerKey, val) {
    if (lowerKey.includes("email") || lowerKey.includes("correo")) {
        return _maskEmail(String(val));
    }
    if (lowerKey.includes("phone") || lowerKey.includes("telefono")) {
        return _maskPhone(String(val));
    }
    if (
        lowerKey.includes("name") ||
        lowerKey.includes('name') ||
        lowerKey.includes("apellidos")
    ) {
        return _maskName(String(val));
    }
    return "[REDACTED_PII]";
}

function sanitizeValue(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
        const result = value.map((item) => sanitizeValue(item, seen));
        seen.delete(value);
        return result;
    }

    const sanitized = {};
    for (const [key, val] of Object.entries(value)) {
        const lowerKey = key.toLowerCase().replace(/[-_\s]/g, "");

        if (SECRET_FIELD_NAMES.has(lowerKey)) {
            sanitized[key] = "[REDACTED_SECRET]";
            continue;
        }

        if (PII_FIELD_NAMES.has(lowerKey)) {
            // [LOG-05] Si el valor es objeto, se sanea recursivamente para no
            // perder estructura (ej: contactDetails con email + phone).
            if (val !== null && typeof val === "object") {
                sanitized[key] = sanitizeValue(val, seen);
            } else if (typeof val === "string") {
                sanitized[key] = _maskByKey(lowerKey, val);
            } else {
                sanitized[key] = "[REDACTED_PII]";
            }
            continue;
        }

        if (val !== null && typeof val === "object") {
            sanitized[key] = sanitizeValue(val, seen);
        } else {
            sanitized[key] = val;
        }
    }

    seen.delete(value);
    return sanitized;
}

// [LOG-04] El spread de context va PRIMERO para que NUNCA pueda sobrescribir
// level, traceId, message ni timestamp. Antes, un context con {level: "X"}
// podia cambiar el nivel impreso en consola.
function formatAndLog(level, message, context = {}, traceId) {
    if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;

    const finalTraceId = traceId || makeTraceId("log");
    const safeContext = _asObject(context);

    const logEntry = {
        ...sanitizeValue(safeContext, new WeakSet()),
        timestamp: new Date().toISOString(),
        level,
        traceId: finalTraceId,
        message: String(message),
    };

    const logLine = JSON.stringify(logEntry);
    switch (level) {
    case "ERROR":
        console.error(logLine);
        break;
    case "WARN":
        console.warn(logLine);
        break;
    case "DEBUG":
        console.log(logLine);
        break;
    default:
        console.info(logLine);
    }
}

// [LOG-06] Construye el contexto de un error de forma segura y uniforme.
function _buildErrorContext(error, baseContext) {
    return {
        ..._asObject(baseContext),
        name: error?.name || "Error",
        message: error?.message,
        stack: _sanitizeStack(error?.stack),
        code: error?.code,
    };
}

export const logger = {
    debug(message, context = {}, traceId) {
        formatAndLog("DEBUG", message, context, traceId);
    },
    info(message, context = {}, traceId) {
        formatAndLog("INFO", message, context, traceId);
    },
    warn(message, context = {}, traceId) {
        formatAndLog("WARN", message, context, traceId);
    },
    error(message, context = {}, traceId) {
        formatAndLog("ERROR", message, context, traceId);
    },
    errorWithStack(error, context = {}, traceId) {
        const errorContext = _buildErrorContext(error, context);
        formatAndLog(
            "ERROR",
            error?.message || "Unknown error",
            errorContext,
            traceId
        );
    },
    child(defaultContext = {}) {
        const safeDefaults = _asObject(defaultContext);
        return {
            debug: (m, c = {}, t) =>
                formatAndLog("DEBUG", m, { ...safeDefaults, ..._asObject(c) }, t),
            info: (m, c = {}, t) =>
                formatAndLog("INFO", m, { ...safeDefaults, ..._asObject(c) }, t),
            warn: (m, c = {}, t) =>
                formatAndLog("WARN", m, { ...safeDefaults, ..._asObject(c) }, t),
            error: (m, c = {}, t) =>
                formatAndLog("ERROR", m, { ...safeDefaults, ..._asObject(c) }, t),
            errorWithStack: (e, c = {}, t) => {
                const ec = _buildErrorContext(e, { ...safeDefaults, ..._asObject(c) });
                formatAndLog("ERROR", e?.message || "Unknown error", ec, t);
            },
        };
    },
};

export function withLogging(fn, operationName, defaultContext = {}) {
    const safeDefaults = _asObject(defaultContext);
    return async function (...args) {
        const traceId = makeTraceId(operationName);
        const start = Date.now();
        try {
            logger.info(
                `${operationName}_started`,
                { ...safeDefaults, argsCount: args.length },
                traceId
            );
            const result = await fn(...args);
            const duration = Date.now() - start;
            logger.info(
                `${operationName}_completed`,
                { ...safeDefaults, duration, success: true },
                traceId
            );
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            logger.errorWithStack(
                error,
                { ...safeDefaults, duration, success: false },
                traceId
            );
            throw error;
        }
    };
}

export default logger;
