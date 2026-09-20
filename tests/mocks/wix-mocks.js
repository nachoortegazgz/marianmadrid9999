/**
 * MOCKS REALISTAS DE WIX VELO PARA TESTING - VERSIÓN CORREGIDA
 * 
 * Simulación fiel de las APIs nativas de Wix para ejecución de tests locales.
 * Basado en documentación oficial de Wix Velo V2
 * 
 * @version v5009.0-VERIFACTU-READY
 */

const mockState = {
  collections: new Map(),
  secrets: new Map(),
  bookings: [],
  payments: [],
  orders: [],
  contacts: [],
  webhooks: []
};

function initializeMockCollections() {
  const ssotCollections = [
    'CitasF2', 'MovimientosCaja', 'CajaActual', 'AsientosContables',
    'LibroAsientosContablesDetalle', 'EventosSistemaFacturacion',
    'SlotLocks', 'BookingTransactions', 'DualSlotCache',
    'AvailabilityDaysCache', 'InventarioStockVenta', 'MovimientosInventario',
    'ServiciosCatalogo', 'MapaStaff', 'ProcessedWebhookEvents'
  ];
  
  ssotCollections.forEach(name => {
    mockState.collections.set(name, []);
  });
  
  mockState.secrets.set('FISCAL_KEY', 'mock-fiscal-key-for-testing-only');
  mockState.secrets.set('FISCAL_NIF_EMISOR', 'B12345678');
  mockState.secrets.set('M365_HMAC_KEY', 'mock-m365-hmac-key');
}

initializeMockCollections();

export const wixData = {
  query: (collectionId) => {
    if (!mockState.collections.has(collectionId)) {
      throw new Error(`Collection '${collectionId}' not found`);
    }
    
    const data = mockState.collections.get(collectionId);
    let filtered = [...data];
    let sorted = null;
    let limitValue = null;
    let skipValue = 0;
    
    // Usar función constructora para mantener referencia correcta
    function QueryBuilder() {
      this.eq = (field, value) => {
        filtered = filtered.filter(item => item[field] === value);
        return this;
      };
      this.ne = (field, value) => {
        filtered = filtered.filter(item => item[field] !== value);
        return this;
      };
      this.lt = (field, value) => {
        filtered = filtered.filter(item => item[field] < value);
        return this;
      };
      this.lte = (field, value) => {
        filtered = filtered.filter(item => item[field] <= value);
        return this;
      };
      this.gt = (field, value) => {
        filtered = filtered.filter(item => item[field] > value);
        return this;
      };
      this.gte = (field, value) => {
        filtered = filtered.filter(item => item[field] >= value);
        return this;
      };
      this.contains = (field, value) => {
        filtered = filtered.filter(item => 
          item[field] && item[field].toString().includes(value.toString())
        );
        return this;
      };
      this.startsWith = (field, prefix) => {
        filtered = filtered.filter(item => 
          item[field] && item[field].toString().startsWith(prefix.toString())
        );
        return this;
      };
      this.orderBy = (field, order = 'ASC') => {
        sorted = [...filtered].sort((a, b) => {
          const aVal = a[field];
          const bVal = b[field];
          if (aVal < bVal) return order === 'ASC' ? -1 : 1;
          if (aVal > bVal) return order === 'ASC' ? 1 : -1;
          return 0;
        });
        return this;
      };
      this.limit = (count) => {
        limitValue = count;
        return this;
      };
      this.skip = (count) => {
        skipValue = count;
        return this;
      };
      this.find = async () => {
        let result = sorted || filtered;
        if (skipValue > 0) result = result.slice(skipValue);
        if (limitValue !== null) result = result.slice(0, limitValue);
        
        return {
          items: result,
          totalCount: filtered.length,
          hasNext: limitValue !== null && result.length === limitValue
        };
      };
      this.findOne = async () => {
        const result = sorted || filtered;
        return result.length > 0 ? result[0] : null;
      };
    }
    
    return new QueryBuilder();
  },

  insert: async (collectionId, document) => {
    if (!mockState.collections.has(collectionId)) {
      throw new Error(`Collection '${collectionId}' not found`);
    }
    
    const newItem = {
      ...document,
      _id: document._id || `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      _createdDate: new Date().toISOString(),
      _updatedDate: new Date().toISOString()
    };
    
    mockState.collections.get(collectionId).push(newItem);
    return newItem;
  },

  update: async (collectionId, document) => {
    if (!document._id) {
      throw new Error('Document must have _id for update');
    }
    
    const collection = mockState.collections.get(collectionId);
    const index = collection.findIndex(item => item._id === document._id);
    
    if (index === -1) {
      throw new Error(`Document with _id '${document._id}' not found`);
    }
    
    const updatedItem = {
      ...collection[index],
      ...document,
      _updatedDate: new Date().toISOString()
    };
    
    collection[index] = updatedItem;
    return updatedItem;
  },

  bulkInsert: async (collectionId, documents) => {
    const results = [];
    for (const doc of documents) {
      try {
        const result = await wixData.insert(collectionId, doc);
        results.push({ success: true, item: result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    return { results };
  },

  get: async (collectionId, id) => {
    const collection = mockState.collections.get(collectionId);
    const item = collection.find(doc => doc._id === id);
    
    if (!item) {
      throw new Error(`Document with _id '${id}' not found in '${collectionId}'`);
    }
    
    return item;
  },

  remove: async (collectionId, id) => {
    const collection = mockState.collections.get(collectionId);
    const index = collection.findIndex(item => item._id === id);
    
    if (index === -1) {
      throw new Error(`Document with _id '${id}' not found`);
    }
    
    const removed = collection.splice(index, 1)[0];
    return removed;
  }
};

export const bookings = {
  createBooking: async (payload, options = {}) => {
    if (!payload.bookedEntity || !payload.bookedEntity.slot) {
      throw new Error('BOOKED_ENTITY_SLOT_REQUIRED');
    }
    
    const slot = payload.bookedEntity.slot;
    
    if (!slot.startDate || !slot.endDate) {
      throw new Error('SLOT_DATES_REQUIRED');
    }
    
    if (!slot.resource || !slot.resource.id) {
      throw new Error('SLOT_RESOURCE_ID_REQUIRED');
    }
    
    if (!slot.location || !slot.location.id) {
      throw new Error('SLOT_LOCATION_ID_REQUIRED');
    }
    
    const bookingId = `mock_booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const booking = {
      _id: bookingId,
      bookedEntity: {
        slot: {
          startDate: slot.startDate,
          endDate: slot.endDate,
          resource: { id: slot.resource.id, name: slot.resource.name || 'Staff' },
          location: { 
            id: slot.location.id, 
            locationType: slot.location.locationType || 'OWNER_BUSINESS' 
          },
          status: 'BOOKED'
        }
      },
      contactDetails: payload.contactDetails || {},
      totalParticipants: payload.totalParticipants || 1,
      status: options.flowControlSettings?.skipAvailabilityValidation ? 'CONFIRMED' : 'PENDING',
      paymentStatus: 'NOT_PAID',
      _createdDate: new Date().toISOString(),
      _updatedDate: new Date().toISOString()
    };
    
    mockState.bookings.push(booking);
    
    return { booking };
  },

  cancelBooking: async (bookingId, reason) => {
    const booking = mockState.bookings.find(b => b._id === bookingId);
    
    if (!booking) {
      throw new Error(`Booking '${bookingId}' not found`);
    }
    
    booking.status = 'CANCELED';
    booking.cancellationReason = reason || 'Customer requested cancellation';
    booking._updatedDate = new Date().toISOString();
    
    return { booking };
  },

  confirmBooking: async (bookingId) => {
    const booking = mockState.bookings.find(b => b._id === bookingId);
    
    if (!booking) {
      throw new Error(`Booking '${bookingId}' not found`);
    }
    
    booking.status = 'CONFIRMED';
    booking._updatedDate = new Date().toISOString();
    
    return { booking };
  },

  rescheduleBooking: async (bookingId, newSlot) => {
    const booking = mockState.bookings.find(b => b._id === bookingId);
    
    if (!booking) {
      throw new Error(`Booking '${bookingId}' not found`);
    }
    
    booking.bookedEntity.slot = {
      ...booking.bookedEntity.slot,
      startDate: newSlot.startDate,
      endDate: newSlot.endDate
    };
    booking._updatedDate = new Date().toISOString();
    
    return { booking };
  },

  getBooking: async (bookingId) => {
    const booking = mockState.bookings.find(b => b._id === bookingId);
    
    if (!booking) {
      throw new Error(`Booking '${bookingId}' not found`);
    }
    
    return { booking };
  },

  queryBookings: () => {
    let filtered = [...mockState.bookings];
    
    return {
      eq: (field, value) => {
        filtered = filtered.filter(b => b[field] === value);
        return { eq, find };
      },
      find: async () => ({
        items: filtered,
        totalCount: filtered.length
      })
    };
  }
};

export const payments = {
  createCheckout: async (payload) => {
    if (!payload.amount || !payload.currency) {
      throw new Error('AMOUNT_AND_CURRENCY_REQUIRED');
    }
    
    const checkoutId = `mock_checkout_${Date.now()}`;
    
    const checkout = {
      _id: checkoutId,
      amount: payload.amount,
      currency: payload.currency || 'EUR',
      description: payload.description || 'Payment',
      status: 'PENDING',
      checkoutUrl: `https://mock-wix-checkout.com/${checkoutId}`,
      _createdDate: new Date().toISOString()
    };
    
    mockState.payments.push(checkout);
    
    return { checkout };
  },

  getCheckout: async (checkoutId) => {
    const checkout = mockState.payments.find(p => p._id === checkoutId);
    
    if (!checkout) {
      throw new Error(`Checkout '${checkoutId}' not found`);
    }
    
    return { checkout };
  },

  refundPayment: async (paymentId, amount) => {
    const payment = mockState.payments.find(p => p._id === paymentId);
    
    if (!payment) {
      throw new Error(`Payment '${paymentId}' not found`);
    }
    
    payment.refundAmount = amount || payment.amount;
    payment.status = 'REFUNDED';
    payment._updatedDate = new Date().toISOString();
    
    return { payment };
  }
};

export const stores = {
  getOrder: async (orderId) => {
    const order = mockState.orders.find(o => o._id === orderId);
    
    if (!order) {
      throw new Error(`Order '${orderId}' not found`);
    }
    
    return { order };
  },

  updateOrder: async (orderId, updates) => {
    const order = mockState.orders.find(o => o._id === orderId);
    
    if (!order) {
      throw new Error(`Order '${orderId}' not found`);
    }
    
    const updatedOrder = { ...order, ...updates, _updatedDate: new Date().toISOString() };
    const index = mockState.orders.findIndex(o => o._id === orderId);
    mockState.orders[index] = updatedOrder;
    
    return { order: updatedOrder };
  },

  refundOrder: async (orderId, reason) => {
    const order = mockState.orders.find(o => o._id === orderId);
    
    if (!order) {
      throw new Error(`Order '${orderId}' not found`);
    }
    
    order.paymentStatus = 'REFUNDED';
    order.refundReason = reason;
    order._updatedDate = new Date().toISOString();
    
    return { order };
  },

  createOrder: async (orderData) => {
    const orderId = `mock_order_${Date.now()}`;
    const order = {
      _id: orderId,
      ...orderData,
      paymentStatus: orderData.paymentStatus || 'PENDING',
      _createdDate: new Date().toISOString(),
      _updatedDate: new Date().toISOString()
    };
    
    mockState.orders.push(order);
    return { order };
  }
};

export const secretsManager = {
  getSecret: async (secretName) => {
    const value = mockState.secrets.get(secretName);
    
    if (!value) {
      throw new Error(`Secret '${secretName}' not found`);
    }
    
    return { secret: { name: secretName, value } };
  },

  setSecret: async (name, value) => {
    mockState.secrets.set(name, value);
    return { secret: { name, value } };
  }
};

export const crm = {
  createContact: async (contactData) => {
    const contactId = `mock_contact_${Date.now()}`;
    
    const contact = {
      _id: contactId,
      ...contactData,
      _createdDate: new Date().toISOString(),
      _updatedDate: new Date().toISOString()
    };
    
    mockState.contacts.push(contact);
    
    return { contact };
  },

  getContact: async (contactId) => {
    const contact = mockState.contacts.find(c => c._id === contactId);
    
    if (!contact) {
      throw new Error(`Contact '${contactId}' not found`);
    }
    
    return { contact };
  },

  updateContact: async (contactId, updates) => {
    const contact = mockState.contacts.find(c => c._id === contactId);
    
    if (!contact) {
      throw new Error(`Contact '${contactId}' not found`);
    }
    
    const updatedContact = { ...contact, ...updates, _updatedDate: new Date().toISOString() };
    const index = mockState.contacts.findIndex(c => c._id === contactId);
    mockState.contacts[index] = updatedContact;
    
    return { contact: updatedContact };
  }
};

export const users = {
  currentUser: {
    id: 'mock_user_12345',
    loginEmail: 'admin@marianmadrid.es',
    role: 'ADMIN',
    loggedIn: true,
    
    getRoles: async () => ['ADMIN'],
    
    grantRole: async (role, memberId) => ({
      member: { id: memberId, roles: [role] }
    }),
    
    revokeRole: async (role, memberId) => ({
      member: { id: memberId, roles: [] }
    })
  }
};

export function resetMocks() {
  initializeMockCollections();
  mockState.bookings = [];
  mockState.payments = [];
  mockState.orders = [];
  mockState.contacts = [];
  mockState.webhooks = [];
}

export function getMockState() {
  return {
    collections: Object.fromEntries(mockState.collections),
    bookings: [...mockState.bookings],
    payments: [...mockState.payments],
    orders: [...mockState.orders],
    contacts: [...mockState.contacts]
  };
}

export async function seedTestData() {
  await wixData.insert('ServiciosCatalogo', {
    _id: 'service_corte_001',
    serviceId: 'corte-basico',
    tituloServicio: 'Corte Básico',
    duracion: 30,
    precio: 15.00,
    estado: 'ACTIVO'
  });

  await wixData.insert('MapaStaff', {
    _id: 'staff_marian',
    resourceId: 'e556070a-6d6a-402e-8422-11133033ea76',
    displayName: 'Marian Madrid',
    scheduleId: '06af20d4-1ec3-49fa-9075-f0691dfa7fd4',
    rol: 'GESTION'
  });

  await wixData.insert('CajaActual', {
    _id: 'CAJA_PRINCIPAL',
    estado: 'ABIERTA',
    saldos: {
      EFECTIVO: 100.00,
      TARJETA: 0,
      BIZUM: 0,
      ONLINE: 0
    },
    aperturaFecha: new Date().toISOString()
  });
}

console.log('✅ Wix Velo Mocks cargados correctamente (v2 corregida)');
console.log('📦 APIs mockeadas: wix-data, wix-bookings.v2, wix-payments.v2, wix-stores.v2, secretsManager, crm, users');
