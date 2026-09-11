window.SANDLOCK_CONFIG = {
  appName: 'SandLock',
  currency: 'EGP',
  policy: {
    oneActiveLockerPerUser: true,
    reminderMinutesBeforeEnd: 15,
    lateFeeMultiplier: 3,
    lateFeeCalculation: 'per-minute',
    damagePolicy: 'User is responsible for confirmed damage and may be charged repair or replacement costs.',
    cancellation: 'Cancellation is available before the reservation start time; once the reserved period starts, the session must be ended normally.'
  },
  mqtt: {
    enabled: true,
    brokerUrl: 'wss://bf67aa96660d4afb962662ccd0a6c3aa.s1.eu.hivemq.cloud:8884/mqtt',
    username: 'sandlock_app',
    password: 'appsand123456',
    baseTopic: 'sandlock',
    qos: 1,
    connectTimeoutMs: 8000,
    ackTimeoutMs: 7000,
    phoneTimeSyncMs: 30000
  },
  lockers: {
    A: { status: 'available', zone: 'Beach Zone 1', battery: 100, rate: 20, note: 'Near the main entrance and first umbrella row.', mqttEnabled: true },
    B: { status: 'available', zone: 'Beach Zone 1', battery: 96, rate: 18, note: 'Close to the shaded seating area.', mqttEnabled: false },
    C: { status: 'reserved',  zone: 'Beach Zone 1', battery: 84, rate: 22, note: 'Near the waterline.', mqttEnabled: false },
    D: { status: 'occupied',  zone: 'Beach Zone 1', battery: 72, rate: 20, note: 'Central beach access point.', mqttEnabled: false },
    E: { status: 'offline',   zone: 'Beach Zone 1', battery: 0,   rate: 16, note: 'Temporarily unavailable.', mqttEnabled: false },
    F: { status: 'offline',   zone: 'Beach Zone 1', battery: 0,   rate: 16, note: 'Temporarily unavailable.', mqttEnabled: false }
  }
};
