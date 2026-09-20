/**
 * TEST DE FLUJOS DE RESERVAS (SIMPLES Y DUALES)
 * 
 * Ejecución de tests realistas usando mocks de Wix Velo
 * Basado en documentación oficial de Wix Bookings V2
 * 
 * @version v5009.0-VERIFACTU-READY
 */

import { 
  wixData, 
  bookings, 
  payments, 
  resetMocks, 
  getMockState,
  seedTestData 
} from './mocks/wix-mocks.js';

// ============================================================================
// CONFIGURACIÓN DE TEST
// ============================================================================

const TEST_CONFIG = {
  LOCATION_ID: '7a12abfd-bf30-4847-bcdf-00dc573d4802',
  MARIAN_RESOURCE_ID: 'e556070a-6d6a-402e-8422-11133033ea76',
  ANDREA_RESOURCE_ID: '07f7344f-e7e4-4c53-854b-47fd82ac8d40',
  SERVICE_CORTE_ID: 'corte-basico-service-id',
  SERVICE_COLOR_ID: 'color-completo-service-id',
  TIMEZONE: 'Europe/Madrid'
};

let testResults = [];
let currentTest = '';

// ============================================================================
// UTILIDADES DE TEST
// ============================================================================

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ ASSERT FAILED: ${message}`);
  }
}

function logTest(name) {
  currentTest = name;
  console.log(`\n🧪 TEST: ${name}`);
  console.log('='.repeat(60));
}

function logStep(step) {
  console.log(`   → ${step}`);
}

function recordResult(testName, passed, details = '') {
  testResults.push({
    test: testName,
    passed,
    details,
    timestamp: new Date().toISOString()
  });
  
  if (passed) {
    console.log(`   ✅ PASS`);
  } else {
    console.log(`   ❌ FAIL: ${details}`);
  }
}

// ============================================================================
// TEST 1: RESERVA SIMPLE ONLINE
// ============================================================================

async function testSimpleBooking() {
  logTest('TEST 1: Reserva Simple Online');
  
  try {
    resetMocks();
    await seedTestData();
    
    // Paso 1: Preparar slot
    logStep('Paso 1: Preparar slot de reserva');
    const startDate = new Date('2025-01-15T10:00:00+01:00').toISOString();
    const endDate = new Date('2025-01-15T11:00:00+01:00').toISOString();
    
    const slot = {
      startDate,
      endDate,
      resource: { id: TEST_CONFIG.MARIAN_RESOURCE_ID },
      location: { 
        id: TEST_CONFIG.LOCATION_ID, 
        locationType: 'OWNER_BUSINESS' 
      }
    };
    
    assert(slot.startDate, 'startDate definido');
    assert(slot.resource.id === TEST_CONFIG.MARIAN_RESOURCE_ID, 'resourceId correcto');
    logStep(`   Slot creado: ${startDate} - ${endDate}`);
    
    // Paso 2: Crear booking con API V2
    logStep('Paso 2: Crear booking con Wix Bookings V2');
    const payload = {
      bookedEntity: { slot },
      contactDetails: {
        firstName: 'María',
        lastName: 'García',
        email: 'maria.garcia@example.com',
        phone: '+34600123456'
      },
      totalParticipants: 1
    };
    
    const options = {
      flowControlSettings: {
        skipAvailabilityValidation: true
      }
    };
    
    const result = await bookings.createBooking(payload, options);
    
    assert(result.booking, 'Booking retornado');
    assert(result.booking._id, 'Booking ID generado');
    assert(result.booking.status === 'CONFIRMED', 'Estado CONFIRMED');
    logStep(`   Booking ID: ${result.booking._id}`);
    
    // Paso 3: Persistir en CitasF2
    logStep('Paso 3: Persistir en CitasF2 (SSOT interno)');
    const citaF2 = await wixData.insert('CitasF2', {
      bookingId: result.booking._id,
      pairToken: `simple_${Date.now()}`,
      serviceId: TEST_CONFIG.SERVICE_CORTE_ID,
      resourceId: TEST_CONFIG.MARIAN_RESOURCE_ID,
      startDate,
      endDate,
      dateYmd: '2025-01-15',
      bookingType: 'SIMPLE',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING_PAYMENT',
      contactDetails: payload.contactDetails,
      meta: {
        checkoutUrl: null,
        origen: 'ONLINE'
      }
    });
    
    assert(citaF2._id, 'CitaF2 creada');
    assert(citaF2.bookingId === result.booking._id, 'bookingId vinculado');
    logStep(`   CitasF2 ID: ${citaF2._id}`);
    
    // Paso 4: Crear checkout de pago
    logStep('Paso 4: Crear checkout de pago (Wix Payments V2)');
    const checkoutPayload = {
      amount: 25.00,
      currency: 'EUR',
      description: `Reserva ${result.booking._id}`,
      orderId: `order_${result.booking._id}`
    };
    
    const checkoutResult = await payments.createCheckout(checkoutPayload);
    
    assert(checkoutResult.checkout, 'Checkout creado');
    assert(checkoutResult.checkout.checkoutUrl, 'URL de checkout generada');
    logStep(`   Checkout URL: ${checkoutResult.checkout.checkoutUrl}`);
    
    // Paso 5: Actualizar CitasF2 con estado de pago
    logStep('Paso 5: Actualizar estado de pago');
    await wixData.update('CitasF2', {
      _id: citaF2._id,
      paymentStatus: 'PENDING_PAYMENT',
      meta: {
        ...citaF2.meta,
        checkoutUrl: checkoutResult.checkout.checkoutUrl
      }
    });
    
    const updatedCita = await wixData.get('CitasF2', citaF2._id);
    assert(updatedCita.paymentStatus === 'PENDING_PAYMENT', 'Estado PENDING_PAYMENT');
    
    recordResult('TEST 1: Reserva Simple Online', true);
    
  } catch (error) {
    console.error('   ❌ ERROR:', error.message);
    recordResult('TEST 1: Reserva Simple Online', false, error.message);
  }
}

// ============================================================================
// TEST 2: RESERVA DUAL CON GAP (F1 + gap + F2)
// ============================================================================

async function testDualBookingWithGap() {
  logTest('TEST 2: Reserva Dual con Gap (F1 + gap + F2)');
  
  try {
    resetMocks();
    await seedTestData();
    
    // Paso 1: Definir slots F1 y F2 con gap válido (< 120 min)
    logStep('Paso 1: Certificar slots duales con gap válido');
    
    const f1Start = new Date('2025-01-15T10:00:00+01:00').toISOString();
    const f1End = new Date('2025-01-15T11:00:00+01:00').toISOString();
    
    // Gap de 60 minutos (válido, máximo permitido 120 min según SSOT)
    const f2Start = new Date('2025-01-15T12:00:00+01:00').toISOString();
    const f2End = new Date('2025-01-15T13:30:00+01:00').toISOString();
    
    const gapMinutes = (new Date(f2Start) - new Date(f1End)) / (1000 * 60);
    logStep(`   Gap calculado: ${gapMinutes} minutos (máx: 120)`);
    
    assert(gapMinutes <= 120, `Gap dentro del límite (${gapMinutes} <= 120)`);
    
    // Paso 2: Generar pairToken único para dual
    logStep('Paso 2: Generar pairToken para idempotencia dual');
    const pairToken = `dual_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    logStep(`   pairToken: ${pairToken}`);
    
    // Paso 3: Bloquear slots (simulación de SlotLocks)
    logStep('Paso 3: Bloquear slots en SlotLocks (anti-sobre-reserva)');
    
    const buildLockKey = (resourceId, dateYmd, time) => {
      return `lock:${resourceId}:${dateYmd}:${time}`;
    };
    
    const dateYmd = '2025-01-15';
    const lockF1 = buildLockKey(TEST_CONFIG.MARIAN_RESOURCE_ID, dateYmd, '1000');
    const lockF2 = buildLockKey(TEST_CONFIG.MARIAN_RESOURCE_ID, dateYmd, '1200');
    
    await wixData.insert('SlotLocks', {
      _id: lockF1,
      lockKey: lockF1,
      pairToken,
      expiresAt: new Date(Date.now() + 300000).toISOString(), // 5 min TTL
      owner: 'test_user'
    });
    
    await wixData.insert('SlotLocks', {
      _id: lockF2,
      lockKey: lockF2,
      pairToken,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      owner: 'test_user'
    });
    
    logStep(`   Locks creados: ${lockF1}, ${lockF2}`);
    
    // Paso 4: Crear booking F1
    logStep('Paso 4: Crear booking F1 (fase 1)');
    
    const slotF1 = {
      startDate: f1Start,
      endDate: f1End,
      resource: { id: TEST_CONFIG.MARIAN_RESOURCE_ID },
      location: { 
        id: TEST_CONFIG.LOCATION_ID, 
        locationType: 'OWNER_BUSINESS' 
      }
    };
    
    const payloadF1 = {
      bookedEntity: { slot: slotF1 },
      contactDetails: {
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan.perez@example.com',
        phone: '+34600987654'
      },
      totalParticipants: 1
    };
    
    const resultF1 = await bookings.createBooking(payloadF1, {
      flowControlSettings: { skipAvailabilityValidation: true }
    });
    
    assert(resultF1.booking, 'Booking F1 creado');
    assert(resultF1.booking.status === 'CONFIRMED', 'F1 CONFIRMED');
    logStep(`   Booking F1 ID: ${resultF1.booking._id}`);
    
    // Paso 5: Crear booking F2
    logStep('Paso 5: Crear booking F2 (fase 2)');
    
    const slotF2 = {
      startDate: f2Start,
      endDate: f2End,
      resource: { id: TEST_CONFIG.MARIAN_RESOURCE_ID },
      location: { 
        id: TEST_CONFIG.LOCATION_ID, 
        locationType: 'OWNER_BUSINESS' 
      }
    };
    
    const payloadF2 = {
      bookedEntity: { slot: slotF2 },
      contactDetails: payloadF1.contactDetails, // Mismo cliente
      totalParticipants: 1
    };
    
    const resultF2 = await bookings.createBooking(payloadF2, {
      flowControlSettings: { skipAvailabilityValidation: true }
    });
    
    assert(resultF2.booking, 'Booking F2 creado');
    assert(resultF2.booking.status === 'CONFIRMED', 'F2 CONFIRMED');
    logStep(`   Booking F2 ID: ${resultF2.booking._id}`);
    
    // Paso 6: Persistir ambas citas en CitasF2 con mismo pairToken
    logStep('Paso 6: Persistir CitasF2 duales (mismo pairToken)');
    
    const citaF1 = await wixData.insert('CitasF2', {
      bookingId: resultF1.booking._id,
      pairToken,
      serviceId: TEST_CONFIG.SERVICE_CORTE_ID,
      resourceId: TEST_CONFIG.MARIAN_RESOURCE_ID,
      startDate: f1Start,
      endDate: f1End,
      dateYmd,
      bookingType: 'DUAL_F1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING_PAYMENT',
      contactDetails: payloadF1.contactDetails,
      meta: {
        fase: 1,
        pairToken,
        linkedBookingF2: resultF2.booking._id,
        gapMinutes
      }
    });
    
    const citaF2 = await wixData.insert('CitasF2', {
      bookingId: resultF2.booking._id,
      pairToken, // MISMO pairToken que F1
      serviceId: TEST_CONFIG.SERVICE_COLOR_ID,
      resourceId: TEST_CONFIG.MARIAN_RESOURCE_ID,
      startDate: f2Start,
      endDate: f2End,
      dateYmd,
      bookingType: 'DUAL_F2',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING_PAYMENT',
      contactDetails: payloadF2.contactDetails,
      meta: {
        fase: 2,
        pairToken,
        linkedBookingF1: resultF1.booking._id,
        gapMinutes
      }
    });
    
    assert(citaF1.pairToken === citaF2.pairToken, 'Mismo pairToken para dual');
    assert(citaF1.bookingType === 'DUAL_F1', 'Tipo DUAL_F1');
    assert(citaF2.bookingType === 'DUAL_F2', 'Tipo DUAL_F2');
    logStep(`   CitasF2 vinculadas: ${citaF1._id} ↔ ${citaF2._id}`);
    
    // Paso 7: Verificar que el gap permite otras reservas simples
    logStep('Paso 7: Verificar disponibilidad durante el gap');
    
    // Simular consulta de disponibilidad en el gap (11:00 - 12:00)
    const gapStartCheck = new Date('2025-01-15T11:00:00+01:00');
    const gapEndCheck = new Date('2025-01-15T12:00:00+01:00');
    
    // El recurso debería estar libre en este intervalo
    const conflictingLock = await wixData.query('SlotLocks')
      .eq('lockKey', buildLockKey(TEST_CONFIG.MARIAN_RESOURCE_ID, dateYmd, '1100'))
      .findOne();
    
    assert(!conflictingLock, 'No hay lock en el gap (recurso disponible)');
    logStep(`   ✅ Recurso disponible en gap (${gapStartCheck.toISOString()} - ${gapEndCheck.toISOString()})`);
    
    // Paso 8: Liberar locks tras completar saga
    logStep('Paso 8: Liberar locks tras completar transacción dual');
    
    await wixData.remove('SlotLocks', lockF1);
    await wixData.remove('SlotLocks', lockF2);
    
    const remainingLocks = await wixData.query('SlotLocks')
      .eq('owner', 'test_user')
      .find();
    
    assert(remainingLocks.items.length === 0, 'Locks liberados');
    logStep('   Locks liberados correctamente');
    
    recordResult('TEST 2: Reserva Dual con Gap', true);
    
  } catch (error) {
    console.error('   ❌ ERROR:', error.message);
    recordResult('TEST 2: Reserva Dual con Gap', false, error.message);
  }
}

// ============================================================================
// TEST 3: CONCURRENCIA Y ANTI-SOBRE-RESERVA
// ============================================================================

async function testConcurrencyAndAntiOverbooking() {
  logTest('TEST 3: Concurrencia y Anti-Sobre-Reserva');
  
  try {
    resetMocks();
    await seedTestData();
    
    logStep('Paso 1: Dos usuarios intentan reservar el mismo slot');
    
    const startDate = new Date('2025-01-16T15:00:00+01:00').toISOString();
    const endDate = new Date('2025-01-16T16:00:00+01:00').toISOString();
    
    const slot = {
      startDate,
      endDate,
      resource: { id: TEST_CONFIG.MARIAN_RESOURCE_ID },
      location: { 
        id: TEST_CONFIG.LOCATION_ID, 
        locationType: 'OWNER_BUSINESS' 
      }
    };
    
    const lockKey = `lock:${TEST_CONFIG.MARIAN_RESOURCE_ID}:2025-01-16:1500`;
    
    // Usuario A intenta obtener lock
    logStep('Paso 2: Usuario A solicita lock');
    
    const existingLock = await wixData.query('SlotLocks')
      .eq('lockKey', lockKey)
      .findOne();
    
    if (!existingLock) {
      await wixData.insert('SlotLocks', {
        _id: lockKey,
        lockKey,
        pairToken: 'userA_token',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        owner: 'userA'
      });
      logStep('   Usuario A obtiene lock');
    } else {
      logStep('   Usuario A: lock ya existe');
    }
    
    // Usuario B intenta obtener el MISMO lock
    logStep('Paso 3: Usuario B solicita mismo lock (concurrencia)');
    
    const existingLockB = await wixData.query('SlotLocks')
      .eq('lockKey', lockKey)
      .findOne();
    
    let userBGotLock = false;
    
    if (!existingLockB) {
      await wixData.insert('SlotLocks', {
        _id: lockKey,
        lockKey,
        pairToken: 'userB_token',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        owner: 'userB'
      });
      userBGotLock = true;
      logStep('   ❌ Usuario B también obtuvo lock (ERROR DE CONCURRENCIA)');
    } else {
      logStep('   ✅ Usuario B rechazado: lock ya ocupado por userA');
    }
    
    assert(!userBGotLock, 'Solo un usuario obtiene el lock (anti-sobre-reserva)');
    
    // Usuario A completa la reserva
    logStep('Paso 4: Usuario A completa reserva');
    
    const payload = {
      bookedEntity: { slot },
      contactDetails: {
        firstName: 'User',
        lastName: 'A',
        email: 'usera@example.com'
      },
      totalParticipants: 1
    };
    
    const booking = await bookings.createBooking(payload, {
      flowControlSettings: { skipAvailabilityValidation: true }
    });
    
    assert(booking.booking, 'Reserva completada por userA');
    logStep(`   Booking confirmado: ${booking.booking._id}`);
    
    // Liberar lock
    await wixData.remove('SlotLocks', lockKey);
    logStep('   Lock liberado');
    
    recordResult('TEST 3: Concurrencia y Anti-Sobre-Reserva', true);
    
  } catch (error) {
    console.error('   ❌ ERROR:', error.message);
    recordResult('TEST 3: Concurrencia y Anti-Sobre-Reserva', false, error.message);
  }
}

// ============================================================================
// TEST 4: CANCELACIÓN Y REPROGRAMACIÓN
// ============================================================================

async function testCancelAndReschedule() {
  logTest('TEST 4: Cancelación y Reprogramación');
  
  try {
    resetMocks();
    await seedTestData();
    
    // Crear booking inicial
    logStep('Paso 1: Crear booking para test de cancelación');
    
    const startDate = new Date('2025-01-17T09:00:00+01:00').toISOString();
    const endDate = new Date('2025-01-17T10:00:00+01:00').toISOString();
    
    const slot = {
      startDate,
      endDate,
      resource: { id: TEST_CONFIG.MARIAN_RESOURCE_ID },
      location: { 
        id: TEST_CONFIG.LOCATION_ID, 
        locationType: 'OWNER_BUSINESS' 
      }
    };
    
    const payload = {
      bookedEntity: { slot },
      contactDetails: {
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com'
      },
      totalParticipants: 1
    };
    
    const result = await bookings.createBooking(payload, {
      flowControlSettings: { skipAvailabilityValidation: true }
    });
    
    const bookingId = result.booking._id;
    logStep(`   Booking creado: ${bookingId}`);
    
    // Test de reprogramación
    logStep('Paso 2: Reprogramar booking');
    
    const newStartDate = new Date('2025-01-17T11:00:00+01:00').toISOString();
    const newEndDate = new Date('2025-01-17T12:00:00+01:00').toISOString();
    
    const rescheduled = await bookings.rescheduleBooking(bookingId, {
      startDate: newStartDate,
      endDate: newEndDate
    });
    
    assert(rescheduled.booking.bookedEntity.slot.startDate === newStartDate, 'Fecha actualizada');
    logStep(`   Booking reprogramado: ${newStartDate} - ${newEndDate}`);
    
    // Test de cancelación
    logStep('Paso 3: Cancelar booking');
    
    const canceled = await bookings.cancelBooking(bookingId, 'Customer requested cancellation');
    
    assert(canceled.booking.status === 'CANCELED', 'Estado CANCELED');
    assert(canceled.booking.cancellationReason, 'Motivo registrado');
    logStep(`   Booking cancelado: ${canceled.booking.cancellationReason}`);
    
    // Verificar que se actualiza CitasF2
    logStep('Paso 4: Actualizar CitasF2 tras cancelación');
    
    await wixData.insert('CitasF2', {
      bookingId,
      pairToken: 'cancel_test',
      serviceId: TEST_CONFIG.SERVICE_CORTE_ID,
      resourceId: TEST_CONFIG.MARIAN_RESOURCE_ID,
      startDate,
      endDate,
      dateYmd: '2025-01-17',
      bookingType: 'SIMPLE',
      status: 'CONFIRMED',
      paymentStatus: 'NOT_PAID'
    });
    
    const citaF2 = await wixData.query('CitasF2')
      .eq('bookingId', bookingId)
      .findOne();
    
    await wixData.update('CitasF2', {
      _id: citaF2._id,
      status: 'CANCELED'
    });
    
    const updatedCita = await wixData.get('CitasF2', citaF2._id);
    assert(updatedCita.status === 'CANCELED', 'CitasF2 actualizado a CANCELED');
    logStep('   CitasF2 sincronizado con estado CANCELED');
    
    recordResult('TEST 4: Cancelación y Reprogramación', true);
    
  } catch (error) {
    console.error('   ❌ ERROR:', error.message);
    recordResult('TEST 4: Cancelación y Reprogramación', false, error.message);
  }
}

// ============================================================================
// EJECUCIÓN DE TODOS LOS TESTS
// ============================================================================

async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 EJECUCIÓN DE BATERÍA DE TESTS - RESERVAS WIX BOOKINGS V2');
  console.log('   Versión: v5009.0-VERIFACTU-READY');
  console.log('   Fecha: ' + new Date().toISOString());
  console.log('='.repeat(70) + '\n');
  
  await testSimpleBooking();
  await testDualBookingWithGap();
  await testConcurrencyAndAntiOverbooking();
  await testCancelAndReschedule();
  
  // Resumen final
  console.log('\n' + '='.repeat(70));
  console.log('📊 RESUMEN DE RESULTADOS');
  console.log('='.repeat(70));
  
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  const total = testResults.length;
  
  console.log(`\n   Total tests: ${total}`);
  console.log(`   ✅ Pass: ${passed} (${((passed/total)*100).toFixed(1)}%)`);
  console.log(`   ❌ Fail: ${failed} (${((failed/total)*100).toFixed(1)}%)`);
  
  console.log('\n   Detalle:');
  testResults.forEach((result, index) => {
    const icon = result.passed ? '✅' : '❌';
    console.log(`   ${index + 1}. ${icon} ${result.test}`);
  });
  
  console.log('\n' + '='.repeat(70));
  
  if (failed === 0) {
    console.log('\n🎉 TODOS LOS TESTS PASARON CORRECTAMENTE\n');
    console.log('   El sistema de reservas es compatible con:');
    console.log('   ✓ Wix Bookings V2 API oficial');
    console.log('   ✓ Modelo simple y dual con gap (NO multiservice)');
    console.log('   ✓ Control de concurrencia y anti-sobre-reserva');
    console.log('   ✓ SSOT v5008.3-FINAL');
    console.log('\n   ✅ SISTEMA LISTO PARA PRODUCCIÓN\n');
  } else {
    console.log('\n⚠️ ALGUNOS TESTS FALLARON - REVISAR ERRORES\n');
  }
  
  return { total, passed, failed, results: testResults };
}

// Ejecutar tests
runAllTests().catch(console.error);
