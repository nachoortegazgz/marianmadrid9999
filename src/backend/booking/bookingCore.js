/*
EMERGENCY STUB - replace with v5008.0-MINIMAL-OFFICIAL from artifacts
*/
import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";

export const ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  TOKEN_BUSY: "TOKEN_BUSY",
  BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
  CHECKOUT_FAILED: "CHECKOUT_FAILED",
  ACCESS_DENIED: "ACCESS_DENIED",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

export class BookingError extends Error {
  constructor(code, message, details = {}) {
    super(String(message || "Unknown error"));
    this.name = "BookingError";
    this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
    this.details = details;
  }
}

export function createBookingError(code, message, details) {
  return new BookingError(code, message, details);
}

export function normalizeError(err) {
  if (err && err.name === "BookingError") {
    return { code: err.code, message: err.message, stack: err.stack || null, details: err.details || {} };
  }
  return { code: ERROR_CODES.UNKNOWN_ERROR, message: String(err && err.message || err), stack: null, details: {} };
}

export const createBookingElevated = elevate(bookings.createBooking);
export const cancelBookingElevated = elevate(bookings.cancelBooking);
export const confirmOrDeclineBookingElevated = elevate(bookings.confirmOrDeclineBooking);
export const createCheckoutElevated = elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = elevate(checkout.getCheckoutUrl);

export function _extractCheckoutId(s) {
  return (s && ((s.checkout && s.checkout._id) || s._id)) || null;
}

export async function _forceStaffInPristineSlot() {
  throw createBookingError(ERROR_CODES.BOOKING_CREATION_FAILED, "bookingCore stub: deploy full v5008.0-MINIMAL-OFFICIAL");
}
export async function _lockSlotKeyOrFail() { return { ok: false, message: "STUB" }; }
export async function _unlockSlotKey() { return { ok: true }; }
export async function _renewLock() { return { ok: false }; }
export function _buildLockKeys() { return []; }
export async function _initTransaction() { return { success: false, error: "STUB" }; }
export async function _completeTransaction() {}
export async function _failTransaction() {}
export async function _persistBooking() { throw new Error("STUB"); }
export async function _getDualPairFromCache() { return null; }
export function _areSlotsContiguous() { return false; }
export function isValidGuid() { return false; }
