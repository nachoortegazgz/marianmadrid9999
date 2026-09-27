# Verification notes

## Wix Bookings Writer V2

- Create Booking: https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/create-booking
- Appointment bookings use `bookedEntity.slot` with `startDate`, `endDate`, `resource`, and `location`.
- Create Booking defaults to `status=CREATED`; only identities with Manage Bookings can set `CONFIRMED`.
- Specifying a resource triggers availability validation.
- `skipAvailabilityValidation=true` bypasses availability and must not be used as the normal creation path.
- Bookings are created with `paymentStatus=UNDEFINED`; Wix eCommerce payment state is synchronized from the order.

## Wix Time Slots V2

- List availability: https://dev.wix.com/docs/api-reference/business-solutions/bookings/time-slots/time-slots-v2/list-availability-time-slots
- Request fields are `serviceId`, `fromLocalDate`, `toLocalDate`, `timeZone`, `locations`, and `resourceTypes`/`includeResourceTypeIds` as applicable.
- `locations[].locationType` for Time Slots is `BUSINESS`.
- Local date boundaries use `YYYY-MM-DDThh:mm:ss` and the upper boundary is exclusive.

## Project SSOT

- `DatosFiscales` is the fiscal configuration source with `recordType=CONFIG_SISTEMA`.
- `CONFIG_SISTEMA_FISCAL` is the documented fiscal singleton identifier.
- `LibroAsientosContablesDetalle` is preserved in this working tree as a transition collection and is blocked from new-module writes by the SSOT contract.
