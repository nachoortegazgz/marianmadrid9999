/**
 * INTEGRATION TEST: dual booking with gap under concurrent contention.
 * Uses the local Wix mocks but exercises the two-lock acquisition contract:
 * one request must acquire F1 + F2, the other must be rejected and rolled back.
 */
import assert from "node:assert/strict";
import { bookings, getMockState, resetMocks, wixData } from "./mocks/wix-mocks.js";

const CONFIG = {
    locationId: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
    resourceId: "e556070a-6d6a-402e-8422-11133033ea76",
    serviceF1: "corte-basico-service-id",
    serviceF2: "color-completo-service-id",
};

const F1 = {
    start: "2025-01-20T10:00:00.000Z",
    end: "2025-01-20T11:00:00.000Z",
};
const F2 = {
    start: "2025-01-20T12:00:00.000Z",
    end: "2025-01-20T13:00:00.000Z",
};

function lockKey(start, end) {
    return `lock:${CONFIG.resourceId}:${start.slice(0, 10)}:${start.slice(11, 16).replace(":", "")}-${end.slice(11, 16).replace(":", "")}`;
}

const LOCK_KEYS = [lockKey(F1.start, F1.end), lockKey(F2.start, F2.end)];

async function acquireDualLocks(pairToken) {
    const acquired = [];
    try {
        for (const key of LOCK_KEYS) {
            await wixData.insert("SlotLocks", {
                _id: key,
                lockKey: key,
                pairToken,
                lockOwnerId: pairToken,
                expiresAt: new Date(Date.now() + 300000).toISOString(),
            });
            acquired.push(key);
        }
        return { acquired: true, pairToken };
    } catch (error) {
        for (const key of acquired) {
            await wixData.remove("SlotLocks", key);
        }
        return { acquired: false, pairToken, error };
    }
}

function slot(phase) {
    return {
        startDate: phase.start,
        endDate: phase.end,
        resource: { id: CONFIG.resourceId },
        location: { id: CONFIG.locationId, locationType: "OWNER_BUSINESS" },
    };
}

async function run() {
    resetMocks();
    const pairA = "dual-concurrent-a";
    const pairB = "dual-concurrent-b";

    const [attemptA, attemptB] = await Promise.all([
        acquireDualLocks(pairA),
        acquireDualLocks(pairB),
    ]);

    const winners = [attemptA, attemptB].filter((attempt) => attempt.acquired);
    const losers = [attemptA, attemptB].filter((attempt) => !attempt.acquired);
    assert.equal(winners.length, 1, "exactly one dual request acquires F1 and F2");
    assert.equal(losers.length, 1, "the competing dual request is rejected");
    assert.equal(losers[0].error?.code, "WD_ITEM_ALREADY_EXISTS", "collision is a unique-key rejection");

    const survivingLocks = getMockState().collections.SlotLocks;
    assert.equal(survivingLocks.length, 2, "only the winning pair retains two locks");
    assert.ok(survivingLocks.every((lock) => lock.pairToken === winners[0].pairToken));

    const contactDetails = {
        firstName: "Concurrent",
        lastName: "Winner",
        email: `${winners[0].pairToken}@example.com`,
    };
    const bookingF1Pending = await bookings.createBooking({
        bookedEntity: { slot: slot(F1) },
        contactDetails,
        totalParticipants: 1,
    });
    const bookingF1 = await bookings.confirmBooking(bookingF1Pending.booking._id);
    const bookingF2Pending = await bookings.createBooking({
        bookedEntity: { slot: slot(F2) },
        contactDetails,
        totalParticipants: 1,
    });
    const bookingF2 = await bookings.confirmBooking(bookingF2Pending.booking._id);

    await wixData.insert("CitasF2", {
        bookingId: bookingF1.booking._id,
        pairToken: winners[0].pairToken,
        serviceId: CONFIG.serviceF1,
        resourceId: CONFIG.resourceId,
        startDate: F1.start,
        endDate: F1.end,
        bookingType: "DUAL_F1",
        status: bookingF1.booking.status,
    });
    await wixData.insert("CitasF2", {
        bookingId: bookingF2.booking._id,
        pairToken: winners[0].pairToken,
        serviceId: CONFIG.serviceF2,
        resourceId: CONFIG.resourceId,
        startDate: F2.start,
        endDate: F2.end,
        bookingType: "DUAL_F2",
        status: bookingF2.booking.status,
    });

    const pairRecords = await wixData.query("CitasF2")
        .eq("pairToken", winners[0].pairToken)
        .find();
    assert.equal(pairRecords.items.length, 2, "F1 and F2 share one pairToken");

    const gapKey = lockKey("2025-01-20T11:00:00.000Z", "2025-01-20T12:00:00.000Z");
    assert.equal(
        (await wixData.query("SlotLocks").eq("lockKey", gapKey).find()).items.length,
        0,
        "the one-hour gap is not locked");

    for (const key of LOCK_KEYS) {
        await wixData.remove("SlotLocks", key);
    }
    assert.equal(getMockState().collections.SlotLocks.length, 0, "all winning locks are released");

    console.log("DUAL_GAP_CONCURRENCY_PASS", JSON.stringify({
        winner: winners[0].pairToken,
        rejected: losers[0].pairToken,
        locks: LOCK_KEYS.length,
        gapMinutes: 60,
        citaRecords: pairRecords.items.length,
    }));
}

await run();
