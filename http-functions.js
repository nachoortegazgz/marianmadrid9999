/*
=============================================================================
MODULE: backend/http-functions.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Endpoints HTTP expuestos. Webhook M365 con validacion HMAC.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo no importa constantes
            renombradas ni toca campos CMS.

CORRECTIONS (heredadas):
  [HTTP-01..HTTP-03].
  [FIX-47].
=============================================================================
*/

import { ok, forbidden, serverError } from "wix-http-functions";
import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";
import { timingSafeEqual, hmacSha256Hex } from "backend/securityEngine";
import { rateLimiter } from "backend/security";

const log = logger;

// =============================================================================
// BLOQUE 1 - VALIDACION HMAC
// =============================================================================

async function _validateHMACSignature(request, bodyString, traceId) {
  try {
    const secret = await getSecret(SECRETS.M365_WEBHOOK_HMAC_KEY);
    if (!secret) {
      log.error("M365_WEBHOOK_HMAC_KEY not found", { traceId });
      return false;
    }

    const providedSignature =
      request.headers?.["x-m365-signature"] ||
      request.headers?.["X-M365-Signature"] ||
      "";

    if (!providedSignature) return false;

    const expectedSignature = await hmacSha256Hex(secret, bodyString);

    return timingSafeEqual(
      String(providedSignature).toLowerCase(),
      String(expectedSignature).toLowerCase()
    );
  } catch (err) {
    log.error("_validateHMACSignature failed", { error: err?.message, traceId });
    return false;
  }
}

// =============================================================================
// BLOQUE 2 - WEBHOOK M365
// =============================================================================

export async function post_webhook_m365(request) {
  const traceId = makeTraceId("m365-wh");
  try {
    const rl = rateLimiter({ surface: "webhook_m365", key: "external" });
    if (!rl.allowed) {
      return forbidden({ body: { error: "RATE_LIMITED" } });
    }

    const bodyString = await request.body.text();
    const isValid = await _validateHMACSignature(request, bodyString, traceId);

    if (!isValid) {
      log.warn("M365 webhook HMAC validation failed", { traceId });
      return forbidden({ body: { error: "INVALID_SIGNATURE" } });
    }

    let payload;
    try {
      payload = JSON.parse(bodyString);
    } catch (_) {
      return forbidden({ body: { error: "INVALID_JSON" } });
    }

    log.info("M365 webhook received", { traceId, eventType: payload?.eventType });

    // Procesar payload segun eventType
    // (Logica especifica segun integracion M365)

    return ok({ body: { status: "RECEIVED", traceId } });
  } catch (err) {
    log.error("post_webhook_m365 failed", { error: err?.message, traceId });
    return serverError({ body: { error: "INTERNAL_ERROR" } });
  }
}