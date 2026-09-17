# Marian Madrid - Backend v5008.3-FINAL

## Objetivo
Sitio funcional, fiable, ligero, profesional, sin friccion con procesos internos de Wix ni apps nativas (Bookings, eCom/Stores).

## Modulos en este paquete (editados)
| Archivo | Destino en repo |
|---------|-----------------|
| bookingCore.js | src/backend/booking/bookingCore.js |
| bookingSaga.js | src/backend/booking/bookingSaga.js |
| reservas.web.js | src/backend/reservas.web.js |
| events.js | src/backend/events.js |
| citasManager.web.js | src/backend/citasManager.web.js |
| cajas.web.js | src/backend/cajas.web.js |
| internalConfig.js | src/backend/internalConfig.js |
| data.js | src/backend/data.js |
| contabilidad.js | src/backend/contabilidad.js (sin cambios logicos; incluido por cadena) |
| marianAssistant.web.js | src/backend/marianAssistant.web.js |
| fiscalAggregator.web.js | src/backend/fiscalAggregator.web.js |
| unit.testRunner.js | src/backend/__tests__/unit.testRunner.js |
| e2e.testRunner.js | src/backend/__tests__/e2e.testRunner.js |

## Cambios clave v5008.3
1. Create Booking oficial (totalParticipants, options 2o arg, ISO, OWNER_BUSINESS, dual secuencial)
2. Alineacion exports consumers (_updateCitaSafe, reschedule, _handleError)
3. Logger canonico backend/logger en todos los modulos tocados
4. ProcessedWebhookEvents (deja de contaminar AlertasOperativas)
5. Proyeccion contable no bloqueante tras cada MovimientosCaja
6. data.js: SecuenciaTickets no-op; hooks LibroAsientosContablesDetalle
7. Codigo muerto: _getDualPairFromCache eliminado

## CMS: crear si no existe
- ProcessedWebhookEvents

## No eliminar (analisis)
Ver VALIDATION_REPORT.json -> consolidationAnalysis.doNotDelete

## Deploy
Copiar archivos a rutas de la tabla, commit, push, publicar sitio Wix.
Seguir checklist de verificacion post-despliegue.
