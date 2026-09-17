/*
EMERGENCY STUB - replace with v5008.0-MINIMAL-OFFICIAL from artifacts
*/
import { createBookingError, ERROR_CODES, normalizeError } from "backend/booking/bookingCore";
import { makeTraceId } from "public/mmUtils";

export function _normalizePersistedMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  return meta;
}

export function _extractCheckoutId(s) {
  return (s && ((s.checkout && s.checkout._id) || s._id)) || null;
}

export async function executeBookingSaga(unsafePayload) {
  const traceId = (unsafePayload && unsafePayload.traceId) || makeTraceId("saga");
  return {
    status: "ERROR",
    data: null,
    error: {
      code: ERROR_CODES.BOOKING_CREATION_FAILED,
      message: "bookingSaga stub: deploy full v5008.0-MINIMAL-OFFICIAL from artifacts",
    },
  };
}

export class BookingSagaOrchestrator {
  constructor(traceId) {
    this.traceId = traceId;
    this.steps = [];
    this.completedSteps = [];
  }
  addStep() {}
  async execute() { return []; }
}
