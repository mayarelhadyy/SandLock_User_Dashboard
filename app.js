(() => {
  const cfg = window.SANDLOCK_CONFIG;
  const screens = [...document.querySelectorAll('.screen')];
  let selectedLocker = 'A';
  let selectedBookingId = null;
  let policyTimer = null;
  let phoneTimeTimer = null;
  const pendingAcks = new Map();
  const sharedLockerStates = new Map();
  const reservationClaims = new Map();
  const userReservationClaims = new Map();
  const mqttDeviceState = { brokerConnected: false, deviceOnline: false, battery: null, door: null, status: null, lastMessageAt: null };
  const MAX_BOOKING_AHEAD_MS = 24 * 60 * 60 * 1000;
  const SYNC_WAIT_MS = 700;
  const CLAIM_WINDOW_MS = 850;
  let userStatePublishTimer = null;
  let activeUserSyncTopic = '';
  let userSyncWaiter = null;
  let accountSyncReady = false;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const pad = (n) => String(n).padStart(2, '0');

  function show(name) {
    screens.forEach(s => s.classList.toggle('active', s.dataset.screen === name));
    const current = screens.find(s => s.dataset.screen === name);
    if (current) current.scrollTop = 0;
    if (name === 'summary') renderSummary();
    if (name === 'confirmation') renderConfirmation();
    if (name === 'my-reservations') renderReservations();
    if (name === 'live-status') renderLiveStatus();
    if (name === 'pin-entry') renderPinEntry();
    if (name === 'history') renderHistory();
    if (name === 'profile') renderProfile();
    if (name === 'payment-method') renderPaymentMethod();
    if (name === 'feedback') renderFeedback();
    if (name === 'support') renderSupport();
    if (name === 'map') { renderFirstRulesNotice(); renderMapStatuses(false); }
    if (name === 'live-status') refreshLivePolicyCard();
  }

  function toast(message) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2300);
  }

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) show(go.dataset.go);
  });

  const getUser = () => JSON.parse(localStorage.getItem('sandlock_user') || 'null');
  const getPending = () => JSON.parse(localStorage.getItem('sandlock_pending_booking') || 'null');

  // Stable account identity for this prototype is derived only from full name + mobile number.
  // Payment-card data is deliberately excluded from identity and cross-device account sync.
  function normalizeIdentityName(name='') {
    return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function stableIdentityHash(value='') {
    // Deterministic 64-bit FNV-1a style hash implemented with BigInt.
    // This keeps PII out of MQTT topic names while remaining identical across devices.
    let h = 1469598103934665603n;
    const prime = 1099511628211n;
    for (const ch of String(value)) {
      h ^= BigInt(ch.codePointAt(0));
      h = BigInt.asUintN(64, h * prime);
    }
    return h.toString(36);
  }

  function userIdentityKey(user=getUser()) {
    if (!user?.mobile || !user?.name) return '';
    return `u_${stableIdentityHash(`${normalizeIdentityName(user.name)}|${String(user.mobile).replace(/\D/g,'')}`)}`;
  }

  function bookingsStorageKey(user=getUser()) {
    const key = userIdentityKey(user);
    return key ? `sandlock_bookings_${key}` : 'sandlock_bookings_guest';
  }

  function migrateLegacyBookingsForUser(user=getUser()) {
    if (!user) return;
    const targetKey = bookingsStorageKey(user);
    if (localStorage.getItem(targetKey)) return;
    const legacy = JSON.parse(localStorage.getItem('sandlock_bookings') || '[]');
    const mine = legacy.filter(b => {
      const mobileMatch = !b.ownerMobile || String(b.ownerMobile) === String(user.mobile);
      const nameMatch = !b.ownerName || normalizeIdentityName(b.ownerName) === normalizeIdentityName(user.name);
      return mobileMatch && nameMatch;
    });
    if (mine.length) localStorage.setItem(targetKey, JSON.stringify(mine));
  }

  function getBookings() {
    const user = getUser();
    if (user) migrateLegacyBookingsForUser(user);
    return JSON.parse(localStorage.getItem(bookingsStorageKey(user)) || '[]');
  }

  function saveBookings(bookings, options={}) {
    localStorage.setItem(bookingsStorageKey(), JSON.stringify(bookings));
    if (options.sync !== false) queueUserStatePublish();
  }

  const getBooking = () => {
    const list = getBookings();
    return list.find(b => b.id === selectedBookingId) || list[0] || null;
  };

  function bookingDateTime(b, which='start') {
    if (!b?.date) return null;
    const time = which === 'end' ? b.to : b.from;
    if (!time) return null;
    const d = new Date(`${b.date}T${time}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function bookingPhase(b, now=new Date()) {
    if (!b) return 'none';
    if (['completed','cancelled'].includes(b.status)) return b.status;
    const start = bookingDateTime(b, 'start');
    const end = bookingDateTime(b, 'end');
    if (!start || !end) return b.status || 'reserved';
    if (now < start) return 'upcoming';
    if (now <= end) return 'active';
    return 'overdue';
  }

  function currentUserOpenBooking(excludeId=null) {
    if (!getUser()) return null;
    return getBookings().find(b => b.id !== excludeId && !['completed','cancelled'].includes(b.status));
  }

  function lateFeeFor(b, now=new Date()) {
    if (!b) return 0;
    const end = bookingDateTime(b, 'end');
    if (!end) return 0;
    const until = b.completedAt ? new Date(b.completedAt) : now;
    const lateMs = Math.max(0, until - end);
    const hours = lateMs / 3600000;
    return Number((hours * Number(b.hourlyRate || 0) * Number(cfg.policy?.lateFeeMultiplier || 3)).toFixed(2));
  }

  function finalTotalFor(b, now=new Date()) {
    return Number((Number(b?.total || 0) + lateFeeFor(b, now)).toFixed(2));
  }

  function formatDurationMs(ms) {
    const total = Math.max(0, Math.floor(Math.abs(ms) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  function accessAllowedNow(b) {
    const phase = bookingPhase(b);
    if (phase === 'upcoming') return { ok:false, message:`Access starts at ${b.from} on ${niceDate(b.date)}.` };
    if (['completed','cancelled'].includes(phase)) return { ok:false, message:'This reservation is no longer active.' };
    return { ok:true, phase };
  }

  const RULES_PROMPT_KEY = 'sandlock_rules_prompt_pending';

  function renderFirstRulesNotice() {
    const notice = $('#rulesFirstNotice');
    if (!notice) return;
    const user = getUser();
    notice.hidden = !user || sessionStorage.getItem(RULES_PROMPT_KEY) !== '1';
  }

  function dismissRulesNotice() {
    sessionStorage.removeItem(RULES_PROMPT_KEY);
    renderFirstRulesNotice();
  }

  // Login / profile demo storage. Full card number is never persisted.
  const fullName = $('#fullName');
  const mobile = $('#mobile');
  const cardNumber = $('#cardNumber');
  const loginError = $('#loginError');
  const saved = getUser();
  if (saved) {
    fullName.value = saved.name || '';
    mobile.value = saved.mobile || '';
  }

  cardNumber.addEventListener('input', () => {
    const digits = cardNumber.value.replace(/\D/g, '').slice(0, 16);
    cardNumber.value = digits.replace(/(.{4})/g, '$1 ').trim();
  });
  mobile.addEventListener('input', () => {
    mobile.value = mobile.value.replace(/\D/g, '').slice(0, 11);
  });

  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = fullName.value.trim();
    const phone = mobile.value.replace(/\D/g, '');
    const card = cardNumber.value.replace(/\D/g, '');
    if (name.length < 2) return loginError.textContent = 'Please enter your full name.';
    if (phone.length < 10) return loginError.textContent = 'Please enter a valid mobile number.';
    if (card.length !== 16) return loginError.textContent = 'Card number must contain 16 digits.';
    localStorage.setItem('sandlock_user', JSON.stringify({
      name,
      mobile: phone,
      paymentLast4: card.slice(-4)
    }));
    migrateLegacyBookingsForUser(getUser());
    // User-facing reminder: show Rules & Guidelines immediately after every successful login.
    sessionStorage.setItem(RULES_PROMPT_KEY, '1');
    loginError.textContent = '';
    show('map');
    syncCurrentAccount({ publishAdmin:true }).catch(err => console.warn('SandLock account sync:', err.message));
  });

  $('#reviewRulesNow')?.addEventListener('click', () => { dismissRulesNotice(); show('rules'); });
  $('#dismissRulesNotice')?.addEventListener('click', dismissRulesNotice);

  const statusLabel = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function effectiveLockerStatus(id, now=new Date()) {
    const shared = sharedLockerStates.get(id);
    if (shared?.active && shared.booking && !['completed','cancelled'].includes(shared.booking.status)) {
      const sharedPhase = bookingPhase(shared.booking, now);
      if (sharedPhase === 'upcoming') return 'reserved';
      if (sharedPhase === 'active' || sharedPhase === 'overdue') return 'occupied';
    }
    const booking = getBookings()
      .filter(b => b.locker === id && !['completed','cancelled'].includes(b.status))
      .sort((a,b) => (bookingDateTime(a,'start')?.getTime() || 0) - (bookingDateTime(b,'start')?.getTime() || 0))[0];
    if (booking) {
      const phase = bookingPhase(booking, now);
      if (phase === 'upcoming') return 'reserved';
      if (phase === 'active' || phase === 'overdue') return 'occupied';
    }
    // If the physical Locker A publishes a recognized status, use it when no reservation owns the locker.
    if (id === 'A' && mqttDeviceState.status) {
      const deviceStatus = String(mqttDeviceState.status).toLowerCase();
      if (['available','reserved','occupied','offline'].includes(deviceStatus)) return deviceStatus;
    }
    return cfg.lockers[id].status;
  }

  function renderMapStatuses(animateChanged=true) {
    const now = new Date();
    $$('.map-hit').forEach(pin => {
      const id = pin.dataset.locker;
      const next = effectiveLockerStatus(id, now);
      const previous = pin.dataset.status;
      if (previous !== next) {
        pin.dataset.status = next;
        pin.setAttribute('aria-label', `Locker ${id} • ${statusLabel(next)}`);
        pin.title = `Locker ${id} — ${statusLabel(next)}`;
        if (animateChanged && previous) {
          pin.classList.remove('status-changing');
          void pin.offsetWidth;
          pin.classList.add('status-changing');
          setTimeout(() => pin.classList.remove('status-changing'), 650);
        }
      }
    });
  }

  function refreshDetailsStatus(id=selectedLocker) {
    const locker = cfg.lockers[id];
    if (!locker) return;
    const currentStatus = effectiveLockerStatus(id);
    $('#detailsStatus').textContent = statusLabel(currentStatus);
    $('#detailsStatus').className = `status-badge ${currentStatus}`;
    const liveBattery = id === 'A' && mqttDeviceState.battery != null ? mqttDeviceState.battery : locker.battery;
    $('#batteryText').textContent = currentStatus === 'offline' ? 'Offline' : `${liveBattery}%`;
    $('#reserveNow').disabled = currentStatus !== 'available';
    $('#reserveNow').textContent = currentStatus === 'available' ? 'Reserve Now' : `${statusLabel(currentStatus)} — Not Available`;
    $('#reserveNow').style.opacity = currentStatus === 'available' ? '1' : '.55';
  }

  function openLocker(id) {
    selectedLocker = id;
    const locker = cfg.lockers[id];
    $('#detailsTitle').textContent = `Locker ${id}`;
    $('#lockerName').textContent = `Locker ${id}`;
    $('#locationText').textContent = locker.zone;
    $('#rateText').textContent = locker.rate;
    $('#noteText').textContent = locker.note;
    refreshDetailsStatus(id);
    show('details');
  }

  $$('.map-hit').forEach(btn => btn.addEventListener('click', () => openLocker(btn.dataset.locker)));
  $('#findFirstAvailable').addEventListener('click', () => {
    const first = Object.keys(cfg.lockers).find(k => effectiveLockerStatus(k) === 'available') || 'A';
    openLocker(first);
  });

  $('#reserveNow').addEventListener('click', () => {
    if (effectiveLockerStatus(selectedLocker) !== 'available') return;
    const existing = currentUserOpenBooking();
    if (cfg.policy?.oneActiveLockerPerUser && existing) {
      selectedBookingId = existing.id;
      toast(`You already have Locker ${existing.locker}. One user can reserve only one locker at a time.`);
      return setTimeout(() => show('my-reservations'), 550);
    }
    const locker = cfg.lockers[selectedLocker];
    $('#reservationTitle').textContent = `Reserve Locker ${selectedLocker}`;
    $('#hourlyText').textContent = locker.rate;
    setDefaultReservationTime();
    show('reservation');
    recalcPrice();
  });

  // Reservation date/time + dynamic pricing.
  const dateInput = $('#bookingDate');
  const startSelect = $('#startTime');
  const endSelect = $('#endTime');
  const durationText = $('#durationText');
  const totalPrice = $('#totalPrice');
  const reservationError = $('#reservationError');

  // Minute-precision booking: users may start/end at any minute (e.g. 19:33),
  // rather than being limited to whole-hour slots.
  function localDateValue(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function timeValue(d) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function timeToMinutes(value) {
    if (!/^\d{2}:\d{2}$/.test(value || '')) return NaN;
    const [h, m] = value.split(':').map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) return NaN;
    return h * 60 + m;
  }

  function formatMinutesDuration(minutes) {
    const mins = Math.max(0, Math.round(Number(minutes) || 0));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h} ${h === 1 ? 'hour' : 'hours'} ${m} min`;
    if (h) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
    return `${m} min`;
  }

  function formatBookingDuration(b) {
    if (Number.isFinite(Number(b?.durationMinutes)) && Number(b.durationMinutes) > 0) return formatMinutesDuration(Number(b.durationMinutes));
    return formatMinutesDuration(Math.round((Number(b?.hours) || 0) * 60));
  }

  function setDefaultReservationTime() {
    const now = new Date();
    const maxAllowed = new Date(now.getTime() + MAX_BOOKING_AHEAD_MS);
    const defaultStart = new Date(now.getTime() + 60_000);
    defaultStart.setSeconds(0, 0);
    const endOfStartDay = new Date(defaultStart);
    endOfStartDay.setHours(23, 59, 0, 0);
    const oneHourLater = new Date(defaultStart.getTime() + 60 * 60_000);
    const defaultEnd = new Date(Math.min(oneHourLater.getTime(), endOfStartDay.getTime(), maxAllowed.getTime()));
    dateInput.value = localDateValue(defaultStart);
    dateInput.min = localDateValue(now);
    dateInput.max = localDateValue(maxAllowed);
    startSelect.value = timeValue(defaultStart);
    endSelect.value = timeValue(defaultEnd);
  }

  setDefaultReservationTime();

  function recalcPrice() {
    const startMinutes = timeToMinutes(startSelect.value);
    const endMinutes = timeToMinutes(endSelect.value);
    const durationMinutes = endMinutes - startMinutes;
    const rate = Number(cfg.lockers[selectedLocker].rate);
    $('#hourlyText').textContent = rate;
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      durationText.textContent = '—';
      totalPrice.textContent = '—';
      reservationError.textContent = 'End time must be after the start time.';
      return false;
    }
    reservationError.textContent = '';
    durationText.textContent = formatMinutesDuration(durationMinutes);
    totalPrice.textContent = Number(((durationMinutes / 60) * rate).toFixed(2));
    return true;
  }

  ['input','change'].forEach(evt => { startSelect.addEventListener(evt, recalcPrice); endSelect.addEventListener(evt, recalcPrice); });
  dateInput.addEventListener('change', recalcPrice);

  function selectedStartDateTime() {
    const d = new Date(`${dateInput.value}T${startSelect.value}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function selectedEndDateTime() {
    const d = new Date(`${dateInput.value}T${endSelect.value}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function validateSelectedStartTime() {
    const start = selectedStartDateTime();
    const end = selectedEndDateTime();
    if (!start || !end) { reservationError.textContent = 'Please choose a valid reservation date and time.'; return false; }
    // Allow a reservation to begin in the current phone minute. Only a fully passed minute is rejected.
    const now = new Date();
    const currentMinute = new Date(now);
    currentMinute.setSeconds(0, 0);
    const maxAllowed = new Date(now.getTime() + MAX_BOOKING_AHEAD_MS);
    if (start < currentMinute) { reservationError.textContent = 'Reservation start time cannot be in a past minute based on your phone/device clock.'; return false; }
    if (start > maxAllowed || end > maxAllowed) { reservationError.textContent = 'Reservations can only be scheduled within the next 24 hours.'; return false; }
    if (end <= start) { reservationError.textContent = 'End time must be after the start time.'; return false; }
    return true;
  }

  $('#continueBooking').addEventListener('click', () => {
    if (!recalcPrice() || !validateSelectedStartTime()) return;
    const existing = currentUserOpenBooking();
    if (cfg.policy?.oneActiveLockerPerUser && existing) {
      selectedBookingId = existing.id;
      toast(`One active locker per user. Locker ${existing.locker} is already assigned to you.`);
      return setTimeout(() => show('my-reservations'), 550);
    }
    const booking = {
      locker: selectedLocker,
      zone: cfg.lockers[selectedLocker].zone,
      note: cfg.lockers[selectedLocker].note,
      date: dateInput.value,
      from: startSelect.value,
      to: endSelect.value,
      durationMinutes: timeToMinutes(endSelect.value) - timeToMinutes(startSelect.value),
      hours: (timeToMinutes(endSelect.value) - timeToMinutes(startSelect.value)) / 60,
      hourlyRate: cfg.lockers[selectedLocker].rate,
      total: Number(totalPrice.textContent)
    };
    localStorage.setItem('sandlock_pending_booking', JSON.stringify(booking));
    show('summary');
  });

  function niceDate(value) {
    if (!value) return '—';
    const [y, m, d] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d));
  }

  // Screen 6: review + user-created reservation PIN.
  const bookingPin = $('#bookingPin');
  const bookingPinConfirm = $('#bookingPinConfirm');
  [bookingPin, bookingPinConfirm].forEach(input => input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
  }));

  function renderSummary() {
    const b = getPending();
    if (!b) return;
    const user = getUser();
    $('#summaryLocker').textContent = `Locker ${b.locker}`;
    $('#summaryLocation').textContent = b.note || b.zone;
    $('#summaryDate').textContent = niceDate(b.date);
    $('#summaryTime').textContent = `${b.from} – ${b.to}`;
    $('#summaryDuration').textContent = formatBookingDuration(b);
    $('#summaryRate').textContent = `${b.hourlyRate} EGP/hr`;
    $('#summaryTotal').textContent = b.total;
    $('#summaryPayment').textContent = user?.paymentLast4 ? `•••• •••• •••• ${user.paymentLast4}` : 'No saved method';
  }

  $('#confirmReservation').addEventListener('click', async () => {
    const button = $('#confirmReservation');
    if (button.disabled) return;
    const b = getPending();
    if (!b) return toast('Please choose a reservation first.');
    const existing = currentUserOpenBooking();
    if (cfg.policy?.oneActiveLockerPerUser && existing) {
      selectedBookingId = existing.id;
      toast(`One user can reserve only one locker. Locker ${existing.locker} is already assigned to you.`);
      return setTimeout(() => show('my-reservations'), 550);
    }
    const pin = bookingPin.value;
    const confirmPin = bookingPinConfirm.value;
    if (!/^\d{4}$/.test(pin)) return $('#pinError').textContent = 'Please create a 4-digit reservation PIN.';
    if (pin === '0000') return $('#pinError').textContent = 'PIN 0000 is reserved for emergency owner access. Please choose another PIN.';
    if (pin !== confirmPin) return $('#pinError').textContent = 'PIN confirmation does not match.';

    const now = new Date();
    const currentMinute = new Date(now); currentMinute.setSeconds(0,0);
    const start = bookingDateTime(b, 'start');
    const end = bookingDateTime(b, 'end');
    if (!start || !end || start < currentMinute || end <= start || end > new Date(now.getTime() + MAX_BOOKING_AHEAD_MS)) {
      $('#pinError').textContent = 'This reservation time is no longer valid. Please select a time within the next 24 hours.';
      return;
    }

    $('#pinError').textContent = '';
    const user = getUser();
    if (!user) return show('login');
    button.disabled = true;
    const originalLabel = button.innerHTML;
    button.textContent = 'Checking availability…';

    try {
      // A broker connection is required at confirmation so all phones see one shared availability state.
      if (!accountSyncReady) await syncCurrentAccount({ publishAdmin:false });
      await claimReservationIntent(b);

      const createdAt = new Date().toISOString();
      const booking = {
        ...b,
        id: `SL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(16).slice(2,6).toUpperCase()}`,
        pin,
        ownerMobile: user.mobile || '',
        ownerName: user.name || '',
        status: 'reserved',
        createdAt,
        updatedAt: createdAt,
        paidAmount: Number(b.total || 0),
        paymentStatus: 'paid-demo',
        lateFeeMultiplier: Number(cfg.policy?.lateFeeMultiplier || 3),
        reminderMinutes: Number(cfg.policy?.reminderMinutesBeforeEnd || 15),
        reminderSent: false,
        syncStatus: 'pending',
        door: 'closed'
      };

      // Publish the shared locker state immediately after the claim wins, before any slower device operation.
      await publishSharedLockerState(booking, true);
      const bookings = getBookings();
      bookings.unshift(booking);
      saveBookings(bookings);
      selectedBookingId = booking.id;
      localStorage.removeItem('sandlock_pending_booking');
      bookingPin.value = '';
      bookingPinConfirm.value = '';
      renderMapStatuses(true);
      await publishCurrentUserState();
      await requestReminderPermission(false);

      try {
        await publishReservationToLocker(booking);
        const updated = getBookings();
        const idx = updated.findIndex(x => x.id === booking.id);
        if (idx >= 0) {
          updated[idx].syncStatus = 'synced';
          updated[idx].syncedAt = new Date().toISOString();
          updated[idx].updatedAt = updated[idx].syncedAt;
          saveBookings(updated);
          await publishCurrentUserState();
        }
      } catch (err) {
        console.warn('SandLock physical locker sync:', err.message);
        toast('Reservation confirmed. Physical locker sync will retry when the device is online.');
      }
      publishAdminEvent('reservation/upsert', booking);
      publishAdminEvent('payment', { bookingId:booking.id, ownerMobile:booking.ownerMobile, type:'Reservation Payment', amount:Number(booking.total||0), status:booking.paymentStatus||'paid-demo', reference:`PAY-${booking.id}` });
      show('confirmation');
    } catch (err) {
      $('#pinError').textContent = err.message || 'Unable to confirm the reservation right now. Please try again.';
      renderMapStatuses(true);
    } finally {
      button.disabled = false;
      button.innerHTML = originalLabel;
    }
  });

  function renderConfirmation() {
    const b = getBooking();
    if (!b) return;
    $('#confirmedLocker').textContent = `Locker ${b.locker}`;
    $('#confirmedDate').textContent = niceDate(b.date);
    $('#confirmedTime').textContent = `${b.from} – ${b.to}`;
    $('#confirmedTotal').textContent = `${b.total} EGP`;
    $('#confirmedPin').textContent = b.pin;
  }

  $('#copyPin').addEventListener('click', async () => {
    const b = getBooking();
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.pin);
      toast('Reservation PIN copied.');
    } catch {
      toast(`Your reservation PIN is ${b.pin}.`);
    }
  });

  // Screen 8: reservations list + reservation policy state.
  function renderReservations() {
    const user = getUser();
    const list = getBookings().filter(b => !['completed','cancelled'].includes(b.status) && (!b.ownerMobile || !user?.mobile || b.ownerMobile === user.mobile));
    const host = $('#reservationsList');
    const empty = $('#reservationsEmpty');
    host.innerHTML = '';
    empty.style.display = list.length ? 'none' : 'block';
    if (!list.length) return;

    list.forEach(b => {
      const phase = bookingPhase(b);
      const fee = lateFeeFor(b);
      const badgeText = phase === 'overdue' ? 'Overdue' : phase === 'active' ? 'Active' : 'Upcoming';
      const badgeClass = phase;
      const item = document.createElement('article');
      item.className = 'card reservation-item';
      item.innerHTML = `
        <div class="reservation-item-top">
          <div><span class="section-kicker">${b.zone || 'BEACH ZONE 1'}</span><h3>Locker ${b.locker}</h3></div>
          <span class="status-badge-inline ${badgeClass}">${badgeText}</span>
        </div>
        <div class="reservation-item-body">
          <div><span>Date</span><strong>${niceDate(b.date)}</strong></div>
          <div><span>Time</span><strong>${b.from} – ${b.to}</strong></div>
          <div><span>Duration</span><strong>${formatBookingDuration(b)}</strong></div>
          <div><span>Paid</span><strong>${Number(b.total).toFixed(2).replace('.00','')} EGP</strong></div>
        </div>
        <div class="reservation-pin-box"><span>Reservation PIN</span><strong>${b.pin}</strong></div>
        ${phase === 'overdue' ? `<div class="reservation-late-line">Late fee now: ${fee.toFixed(2)} EGP • overtime is charged at ${cfg.policy.lateFeeMultiplier}× the normal rate</div>` : `<div class="reservation-reminder-line">🔔 Reminder: ${cfg.policy.reminderMinutesBeforeEnd} minutes before booking end</div>`}
        <div class="reservation-item-actions">
          <button class="btn btn-ghost" data-booking-action="live" data-id="${b.id}">Live Status</button>
          <button class="btn btn-primary" data-booking-action="unlock" data-id="${b.id}">${phase === 'upcoming' ? 'Access Time' : 'Unlock'}</button>
          ${phase === 'upcoming' ? `<button class="btn cancel-booking-btn" data-booking-action="cancel" data-id="${b.id}">Cancel Reservation</button>` : ''}
        </div>`;
      host.appendChild(item);
    });
  }

  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-booking-action]');
    if (!action) return;
    selectedBookingId = action.dataset.id;
    if (action.dataset.bookingAction === 'live') show('live-status');
    if (action.dataset.bookingAction === 'cancel') return openCancelModal(getBooking());
    if (action.dataset.bookingAction === 'unlock') {
      const b = getBooking();
      const access = accessAllowedNow(b);
      if (!access.ok) return toast(access.message);
      show('unlock-options');
    }
  });

  // Screen 9: live status + timing compliance + dynamic late fee.
  function renderLiveStatus() {
    const b = getBooking();
    if (!b) return show('my-reservations');
    const locker = cfg.lockers[b.locker];
    $('#liveTitle').textContent = `Locker ${b.locker}`;
    $('#liveLockerName').textContent = `Locker ${b.locker}`;
    const battery = b.locker === 'A' ? mqttDeviceState.battery : locker.battery;
    const door = b.locker === 'A' && mqttDeviceState.door ? mqttDeviceState.door : b.door;
    $('#liveBattery').textContent = battery == null ? '—' : `${battery}%`;
    $('#liveDoor').textContent = String(door || 'closed').toLowerCase() === 'open' ? 'Open' : 'Closed';
    $('#liveConnection').textContent = b.locker === 'A' ? (mqttDeviceState.deviceOnline ? 'Online' : mqttDeviceState.brokerConnected ? 'Broker Online' : 'Offline') : 'Demo';
    const liveBadge = $('#liveDeviceBadge');
    if (liveBadge) { liveBadge.querySelector('span').textContent = mqttDeviceState.deviceOnline ? 'Live • Device Online' : mqttDeviceState.brokerConnected ? 'Live • Waiting for ESP32' : 'Live • Offline'; }
    $('#liveDate').textContent = niceDate(b.date);
    $('#liveTime').textContent = `${b.from} – ${b.to}`;
    $('#livePin').textContent = b.pin;
    $('#liveTotal').textContent = `${Number(b.total).toFixed(2).replace('.00','')} EGP`;
    const cancelBtn = $('#cancelLiveReservation');
    if (cancelBtn) {
      cancelBtn.hidden = bookingPhase(b) !== 'upcoming';
      cancelBtn.dataset.bookingId = b.id;
    }
    refreshLivePolicyCard();
  }

  function refreshLivePolicyCard() {
    const b = getBooking();
    if (!b || !$('#liveScheduleState')) return;
    const now = new Date();
    const phase = bookingPhase(b, now);
    const start = bookingDateTime(b, 'start');
    const end = bookingDateTime(b, 'end');
    const main = $('#timeComplianceCard .compliance-main');
    main?.classList.remove('active','overdue');
    let state = 'Upcoming';
    let copy = start ? `Starts in ${formatDurationMs(start - now)}` : 'Waiting for booking start.';
    if (phase === 'active') {
      state = 'Active reservation';
      copy = `Time remaining: ${formatDurationMs(end - now)}`;
      main?.classList.add('active');
    } else if (phase === 'overdue') {
      state = 'Overdue — late fee active';
      copy = `Overdue by ${formatDurationMs(now - end)}. End the session as soon as your belongings are removed.`;
      main?.classList.add('overdue');
    } else if (phase === 'completed') {
      state = 'Completed';
      copy = 'This reservation has ended.';
    }
    const lateRate = Number(b.hourlyRate || 0) * Number(cfg.policy?.lateFeeMultiplier || 3);
    const lateFee = lateFeeFor(b, now);
    $('#liveScheduleState').textContent = state;
    $('#liveCountdown').textContent = copy;
    $('#liveLateRate').textContent = `${lateRate} EGP/hr (${cfg.policy.lateFeeMultiplier}×)`;
    $('#liveLateFee').textContent = `${lateFee.toFixed(2)} EGP`;
    $('#liveFinalEstimate').textContent = `${finalTotalFor(b, now).toFixed(2)} EGP`;
  }

  // Screens 10–13: real HiveMQ connection, reservation sync, mobile time sync and unlock ACK flow.
  let enteredPin = '';
  let unlockMethod = 'Mobile';
  let mqttClient = null;
  let mqttConnectingPromise = null;

  function mqttTopic(locker, suffix) {
    return `${cfg.mqtt.baseTopic}/locker/${locker}/${suffix}`;
  }

  function setMqttUiState(state, detail='') {
    mqttDeviceState.brokerConnected = state === 'online';
    if (state !== 'online') mqttDeviceState.deviceOnline = false;
    const profile = $('#mqttProfileState');
    const badge = $('#mqttProfileBadge');
    if (profile) profile.textContent = detail || (state === 'online' ? 'Connected to HiveMQ Cloud' : state === 'connecting' ? 'Connecting to HiveMQ Cloud…' : 'Broker reachable • locker waiting');
    if (badge) {
      badge.textContent = state === 'online' ? 'Online' : state === 'connecting' ? 'Connecting' : 'Waiting';
      badge.className = `status-badge-inline ${state === 'online' ? 'active' : 'reserved'}`;
    }
    if ($('#liveConnection') && selectedLocker === 'A') $('#liveConnection').textContent = state === 'online' ? 'Online' : 'Waiting';
  }

  function appSyncTopic(suffix) {
    return mqttTopic('A', `app/sync/${suffix}`);
  }

  function bookingRevision(b={}) {
    const stamps = [b.updatedAt, b.completedAt, b.cancelledAt, b.lastAccessAt, b.syncedAt, b.createdAt];
    for (const stamp of stamps) {
      const t = Date.parse(stamp || '');
      if (Number.isFinite(t) && t > 0) return t;
    }
    return 0;
  }

  function bookingForUserSync(b) {
    const copy = { ...b };
    delete copy.ownerName;
    delete copy.ownerMobile;
    return copy;
  }

  function restoreSyncedBookingOwner(b) {
    const user = getUser();
    return { ...b, ownerName:user?.name || '', ownerMobile:user?.mobile || '' };
  }

  function mergeBookingLists(localList=[], remoteList=[]) {
    const merged = new Map();
    [...localList, ...remoteList].forEach(raw => {
      if (!raw?.id) return;
      const b = restoreSyncedBookingOwner(raw);
      const prev = merged.get(b.id);
      if (!prev || bookingRevision(b) >= bookingRevision(prev)) merged.set(b.id, b);
    });
    return [...merged.values()].sort((a,b) => bookingRevision(b) - bookingRevision(a));
  }

  function refreshVisibleBookingViews() {
    const currentScreen = screens.find(x => x.classList.contains('active'))?.dataset.screen;
    if (currentScreen === 'my-reservations') renderReservations();
    if (currentScreen === 'history') renderHistory();
    if (currentScreen === 'live-status') renderLiveStatus();
    if (currentScreen === 'map') renderMapStatuses(true);
    if (currentScreen === 'details') refreshDetailsStatus(selectedLocker);
  }

  function applyUserStateSnapshot(data) {
    const key = userIdentityKey();
    if (!key || data?.userKey !== key || !Array.isArray(data.bookings)) return;
    const merged = mergeBookingLists(getBookings(), data.bookings);
    saveBookings(merged, { sync:false });
    if (userSyncWaiter?.topic === appSyncTopic(`users/${key}`)) {
      clearTimeout(userSyncWaiter.timer);
      userSyncWaiter.resolve(true);
      userSyncWaiter = null;
    }
    refreshVisibleBookingViews();
  }

  function normalizeSharedBooking(raw={}) {
    if (!raw.id || !raw.locker || !raw.date || !raw.from || !raw.to) return null;
    return {
      id: raw.id,
      locker: raw.locker,
      date: raw.date,
      from: raw.from,
      to: raw.to,
      status: raw.status || 'reserved',
      createdAt: raw.createdAt || raw.updatedAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
      ownerKey: raw.ownerKey || ''
    };
  }

  function applySharedLockerState(locker, data) {
    if (!locker || !cfg.lockers[locker]) return;
    const booking = normalizeSharedBooking(data?.booking || {});
    if (!data?.active || !booking || ['cancelled','completed'].includes(booking.status)) {
      sharedLockerStates.delete(locker);
    } else {
      sharedLockerStates.set(locker, { active:true, booking, updatedAt:data.updatedAt || new Date().toISOString() });
    }
    renderMapStatuses(true);
    const currentScreen = screens.find(x => x.classList.contains('active'))?.dataset.screen;
    if (currentScreen === 'details' && selectedLocker === locker) refreshDetailsStatus(locker);
  }

  function rememberClaim(store, key, data) {
    if (!key || !data?.claimId || !data?.expiresAt) return;
    const expires = Number(data.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) return;
    if (!store.has(key)) store.set(key, new Map());
    const bucket = store.get(key);
    bucket.set(data.claimId, data);
    for (const [id, claim] of bucket.entries()) if (Number(claim.expiresAt) <= Date.now()) bucket.delete(id);
  }

  function handleAppSyncMessage(topic, data) {
    const syncRoot = `${cfg.mqtt.baseTopic}/locker/A/app/sync/`;
    if (!topic.startsWith(syncRoot)) return false;
    const suffix = topic.slice(syncRoot.length);
    if (suffix.startsWith('users/')) {
      applyUserStateSnapshot(data);
    } else if (suffix.startsWith('lockers/')) {
      applySharedLockerState(suffix.split('/')[1], data);
    } else if (suffix.startsWith('claims/locker/')) {
      rememberClaim(reservationClaims, suffix.split('/')[2], data);
    } else if (suffix.startsWith('claims/user/')) {
      rememberClaim(userReservationClaims, suffix.split('/')[2], data);
    }
    return true;
  }

  function subscribeAppSyncTopics(client) {
    const topics = [
      appSyncTopic('lockers/+'),
      appSyncTopic('claims/locker/+'),
      appSyncTopic('claims/user/+')
    ];
    client.subscribe(topics, { qos:Number(cfg.mqtt.qos || 1) }, err => {
      if (err) console.warn('SandLock app sync subscribe error', err);
    });
  }

  function subscribeCurrentUserState(client) {
    const key = userIdentityKey();
    if (!key) return Promise.resolve(false);
    const topic = appSyncTopic(`users/${key}`);
    activeUserSyncTopic = topic;
    return new Promise(resolve => {
      if (userSyncWaiter) {
        clearTimeout(userSyncWaiter.timer);
        userSyncWaiter.resolve(false);
      }
      const timer = setTimeout(() => {
        if (userSyncWaiter?.topic === topic) userSyncWaiter = null;
        resolve(false);
      }, SYNC_WAIT_MS);
      userSyncWaiter = { topic, resolve, timer };
      client.subscribe(topic, { qos:Number(cfg.mqtt.qos || 1) }, err => {
        if (err) {
          clearTimeout(timer);
          if (userSyncWaiter?.topic === topic) userSyncWaiter = null;
          resolve(false);
        }
      });
    });
  }

  async function publishCurrentUserState() {
    const user = getUser();
    const key = userIdentityKey(user);
    if (!user || !key || !accountSyncReady) return false;
    const client = await ensureMqttClient();
    const payload = JSON.stringify({
      version:1,
      userKey:key,
      bookings:getBookings().map(bookingForUserSync),
      updatedAt:new Date().toISOString()
    });
    await publishAsync(client, appSyncTopic(`users/${key}`), payload, { retain:true });
    return true;
  }

  function queueUserStatePublish() {
    if (!accountSyncReady || !getUser()) return;
    clearTimeout(userStatePublishTimer);
    userStatePublishTimer = setTimeout(() => publishCurrentUserState().catch(()=>{}), 140);
  }

  async function publishSharedLockerState(booking, active=true) {
    if (!booking?.locker) return false;
    const client = await ensureMqttClient();
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({
      version:1,
      active:Boolean(active),
      booking:{
        id:booking.id,
        locker:booking.locker,
        date:booking.date,
        from:booking.from,
        to:booking.to,
        status:active ? (booking.status || 'reserved') : (booking.status || 'cancelled'),
        createdAt:booking.createdAt || nowIso,
        updatedAt:nowIso,
        ownerKey:userIdentityKey()
      },
      updatedAt:nowIso
    });
    await publishAsync(client, appSyncTopic(`lockers/${booking.locker}`), payload, { retain:true });
    applySharedLockerState(booking.locker, JSON.parse(payload));
    return true;
  }

  function bookingsOverlap(a, b) {
    const aStart = bookingDateTime(a, 'start');
    const aEnd = bookingDateTime(a, 'end');
    const bStart = bookingDateTime(b, 'start');
    const bEnd = bookingDateTime(b, 'end');
    if (!aStart || !aEnd || !bStart || !bEnd) return false;
    return aStart < bEnd && bStart < aEnd;
  }

  function activeSharedBooking(locker) {
    const state = sharedLockerStates.get(locker);
    if (!state?.active || !state.booking) return null;
    const phase = bookingPhase(state.booking);
    if (['completed','cancelled'].includes(phase)) return null;
    return state.booking;
  }

  async function claimReservationIntent(draft) {
    const client = await ensureMqttClient();
    const userKey = userIdentityKey();
    if (!userKey) throw new Error('Please sign in before reserving a locker.');
    const existingShared = activeSharedBooking(draft.locker);
    if (existingShared && bookingsOverlap(existingShared, draft)) throw new Error(`Locker ${draft.locker} was just reserved. Please choose another locker.`);
    if (currentUserOpenBooking()) throw new Error('You already have an open reservation. One user can reserve only one locker at a time.');

    const claimId = `CLM-${Date.now().toString(36)}-${Math.random().toString(16).slice(2,10)}`;
    const createdAt = Date.now();
    const claim = {
      claimId,
      userKey,
      locker:draft.locker,
      date:draft.date,
      from:draft.from,
      to:draft.to,
      createdAt,
      expiresAt:createdAt + 5000
    };
    rememberClaim(reservationClaims, draft.locker, claim);
    rememberClaim(userReservationClaims, userKey, claim);
    await Promise.all([
      publishAsync(client, appSyncTopic(`claims/locker/${draft.locker}`), JSON.stringify(claim), { retain:false }),
      publishAsync(client, appSyncTopic(`claims/user/${userKey}`), JSON.stringify(claim), { retain:false })
    ]);
    await new Promise(resolve => setTimeout(resolve, CLAIM_WINDOW_MS));

    const chooseWinner = (claims, overlapFilter) => {
      const valid = [...(claims?.values?.() || [])]
        .filter(c => Number(c.expiresAt) > Date.now() && overlapFilter(c))
        .sort((a,b) => String(a.claimId).localeCompare(String(b.claimId)));
      return valid[0]?.claimId || claimId;
    };
    const asBooking = c => ({ date:c.date, from:c.from, to:c.to });
    const lockerWinner = chooseWinner(reservationClaims.get(draft.locker), c => bookingsOverlap(asBooking(c), draft));
    const userWinner = chooseWinner(userReservationClaims.get(userKey), () => true);
    if (lockerWinner !== claimId) throw new Error(`Locker ${draft.locker} was reserved by another user at the same time. Please choose another locker.`);
    if (userWinner !== claimId) throw new Error('Another reservation from this account was confirmed at the same time. Please review My Reservations.');

    const latestShared = activeSharedBooking(draft.locker);
    if (latestShared && bookingsOverlap(latestShared, draft)) throw new Error(`Locker ${draft.locker} is no longer available for this time.`);
    return claimId;
  }

  async function syncCurrentAccount({ publishAdmin=false }={}) {
    const user = getUser();
    if (!user) return false;
    migrateLegacyBookingsForUser(user);
    accountSyncReady = false;
    const client = await ensureMqttClient();
    await subscribeCurrentUserState(client);
    accountSyncReady = true;
    await publishCurrentUserState();
    if (publishAdmin) publishUserSnapshot();
    refreshVisibleBookingViews();
    return true;
  }

  function subscribeLockerTopics(client, locker='A') {
    const topics = [
      mqttTopic(locker, 'status'),
      mqttTopic(locker, 'door'),
      mqttTopic(locker, 'battery'),
      mqttTopic(locker, 'ack'),
      mqttTopic(locker, 'alert')
    ];
    client.subscribe(topics, { qos: Number(cfg.mqtt.qos || 1) }, err => {
      if (err) console.warn('SandLock MQTT subscribe error', err);
    });
  }

  function safeJson(payload) {
    const text = payload?.toString?.() ?? String(payload ?? '');
    try { return JSON.parse(text); } catch { return { value: text }; }
  }

  function handleMqttMessage(topic, payload) {
    const data = safeJson(payload);
    if (handleAppSyncMessage(topic, data)) return;
    mqttDeviceState.lastMessageAt = new Date().toISOString();
    mqttDeviceState.deviceOnline = true;
    if (topic.endsWith('/battery')) {
      const n = Number(data.battery ?? data.percent ?? data.value);
      if (Number.isFinite(n)) mqttDeviceState.battery = Math.max(0, Math.min(100, Math.round(n)));
    } else if (topic.endsWith('/door')) {
      mqttDeviceState.door = String(data.door ?? data.state ?? data.value ?? '').toLowerCase();
    } else if (topic.endsWith('/status')) {
      mqttDeviceState.status = String(data.status ?? data.state ?? data.value ?? 'online');
    } else if (topic.endsWith('/alert')) {
      const msg = data.message || data.alert || data.value || 'Locker alert received.';
      toast(`Locker alert: ${msg}`);
    } else if (topic.endsWith('/ack')) {
      const requestId = data.requestId || data.id;
      if (requestId && pendingAcks.has(requestId)) {
        const pending = pendingAcks.get(requestId);
        pendingAcks.delete(requestId);
        clearTimeout(pending.timer);
        if (data.success === false || data.ok === false) pending.reject(new Error(data.message || 'Locker rejected the command.'));
        else pending.resolve(data);
      } else if (pendingAcks.size === 1) {
        const [key,pending] = pendingAcks.entries().next().value;
        pendingAcks.delete(key); clearTimeout(pending.timer); pending.resolve(data);
      }
    }
    const activeScreen = screens.find(x => x.classList.contains('active'))?.dataset.screen;
    if (activeScreen === 'live-status') renderLiveStatus();
    if (activeScreen === 'map') renderMapStatuses(true);
    if (activeScreen === 'details') refreshDetailsStatus(selectedLocker);
  }

  function ensureMqttClient() {
    if (!cfg.mqtt.enabled) return Promise.reject(new Error('MQTT is disabled.'));
    if (!window.mqtt) return Promise.reject(new Error('MQTT.js is not available. Check your internet connection.'));
    if (mqttClient?.connected) return Promise.resolve(mqttClient);
    if (mqttConnectingPromise) return mqttConnectingPromise;
    setMqttUiState('connecting');
    mqttConnectingPromise = new Promise((resolve, reject) => {
      try {
        mqttClient = window.mqtt.connect(cfg.mqtt.brokerUrl, {
          username: cfg.mqtt.username,
          password: cfg.mqtt.password,
          clientId: `sandlock-app-${Math.random().toString(16).slice(2, 10)}`,
          clean: true,
          connectTimeout: Number(cfg.mqtt.connectTimeoutMs || 8000),
          reconnectPeriod: 2500,
          keepalive: 30
        });
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; mqttConnectingPromise = null; reject(new Error('HiveMQ connection timeout.')); }
        }, Number(cfg.mqtt.connectTimeoutMs || 8000) + 500);
        mqttClient.on('message', handleMqttMessage);
        mqttClient.on('connect', () => {
          clearTimeout(timer);
          subscribeLockerTopics(mqttClient, 'A');
          subscribeAppSyncTopics(mqttClient);
          if (getUser() && activeUserSyncTopic) mqttClient.subscribe(activeUserSyncTopic, { qos:Number(cfg.mqtt.qos || 1) });
          setMqttUiState('online', 'Connected to HiveMQ Cloud • secure WebSocket');
          publishPhoneTime('A').catch(()=>{});
          if (phoneTimeTimer) clearInterval(phoneTimeTimer);
          phoneTimeTimer = setInterval(() => publishPhoneTime('A').catch(()=>{}), Number(cfg.mqtt.phoneTimeSyncMs || 30000));
          if (!settled) { settled = true; resolve(mqttClient); }
          mqttConnectingPromise = null;
        });
        mqttClient.on('reconnect', () => setMqttUiState('connecting','Reconnecting to HiveMQ Cloud…'));
        mqttClient.on('offline', () => setMqttUiState('waiting','HiveMQ connected previously • network offline'));
        mqttClient.on('close', () => setMqttUiState('waiting','HiveMQ broker ready • device/channel waiting'));
        mqttClient.on('error', err => {
          console.warn('SandLock MQTT error', err);
          if (!settled) { clearTimeout(timer); settled = true; mqttConnectingPromise = null; reject(err); }
        });
      } catch (err) { mqttConnectingPromise = null; reject(err); }
    });
    return mqttConnectingPromise;
  }

  function publishAsync(client, topic, payload, options={}) {
    return new Promise((resolve, reject) => client.publish(topic, payload, { qos: Number(cfg.mqtt.qos || 1), ...options }, err => err ? reject(err) : resolve()));
  }

  async function publishAdminEvent(suffix, data, options={}) {
    try {
      const client = await ensureMqttClient();
      const payload = JSON.stringify({ ...data, emittedAt: new Date().toISOString() });
      await publishAsync(client, mqttTopic('A', `app/${suffix}`), payload, options);
      return true;
    } catch { return false; }
  }

  function publishUserSnapshot() {
    const u = getUser();
    if (!u) return;
    publishAdminEvent('user/upsert', { userId:`USR-${String(u.mobile||'').slice(-6)}`, name:u.name||'', mobile:u.mobile||'', paymentLast4:u.paymentLast4||'', status:'active' });
  }

  async function publishPhoneTime(locker='A') {
    if (!cfg.lockers[locker]?.mqttEnabled) return;
    const client = await ensureMqttClient();
    const now = new Date();
    const payload = JSON.stringify({
      source: 'mobile-browser',
      epochMs: now.getTime(),
      epochSeconds: Math.floor(now.getTime()/1000),
      isoUtc: now.toISOString(),
      localDate: `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`,
      localTime: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      timezoneOffsetMinutes: now.getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
    });
    await publishAsync(client, mqttTopic(locker, 'time/set'), payload, { retain: true });
  }

  async function publishReservationToLocker(b) {
    if (!cfg.lockers[b.locker]?.mqttEnabled) return { demo:true };
    const client = await ensureMqttClient();
    const start = bookingDateTime(b,'start');
    const end = bookingDateTime(b,'end');
    const payload = JSON.stringify({
      bookingId: b.id,
      pin: b.pin,
      startEpoch: Math.floor(start.getTime()/1000),
      endEpoch: Math.floor(end.getTime()/1000),
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      localDate: b.date,
      localStart: b.from,
      localEnd: b.to,
      reminderMinutes: Number(cfg.policy.reminderMinutesBeforeEnd || 15),
      lateFeeMultiplier: Number(cfg.policy.lateFeeMultiplier || 3),
      issuedAt: new Date().toISOString()
    });
    await publishAsync(client, mqttTopic(b.locker, 'reservation/set'), payload, { retain: true });
    await publishPhoneTime(b.locker);
    return { demo:false };
  }

  async function clearReservationOnLocker(b) {
    if (!cfg.lockers[b.locker]?.mqttEnabled) return;
    const client = await ensureMqttClient();
    await publishAsync(client, mqttTopic(b.locker, 'reservation/clear'), JSON.stringify({ bookingId:b.id, timestamp:new Date().toISOString() }));
    await publishAsync(client, mqttTopic(b.locker, 'reservation/set'), '', { retain:true });
  }

  // Reservation cancellation: available only before the booking starts.
  let cancelTargetId = null;
  function openCancelModal(b) {
    if (!b) return;
    if (bookingPhase(b) !== 'upcoming') return toast('An active or overdue reservation cannot be cancelled. End the session after collecting your belongings.');
    cancelTargetId = b.id;
    $('#cancelModalBooking').textContent = `Locker ${b.locker} • ${niceDate(b.date)} • ${b.from}–${b.to}`;
    $('#cancelModal').hidden = false;
  }

  function closeCancelModal() {
    cancelTargetId = null;
    $('#cancelModal').hidden = true;
  }

  async function cancelReservation(id) {
    const list = getBookings();
    const idx = list.findIndex(b => b.id === id);
    if (idx < 0) return closeCancelModal();
    const booking = list[idx];
    if (bookingPhase(booking) !== 'upcoming') { closeCancelModal(); return toast('This booking has already started and can no longer be cancelled.'); }
    const cancelledAt = new Date().toISOString();
    list[idx] = { ...booking, status:'cancelled', cancelledAt, updatedAt:cancelledAt, finalTotal:0, refundStatus:'operator-policy' };
    saveBookings(list);
    try { await publishSharedLockerState(list[idx], false); } catch (err) { console.warn('SandLock shared cancellation sync:', err.message); }
    try { await clearReservationOnLocker(booking); } catch (err) { console.warn('SandLock cancellation MQTT sync:', err.message); }
    await publishCurrentUserState().catch(()=>{});
    publishAdminEvent('reservation/cancel', list[idx]);
    if (selectedBookingId === id) selectedBookingId = null;
    closeCancelModal();
    renderMapStatuses(true);
    renderReservations();
    toast(`Locker ${booking.locker} reservation cancelled. The locker is available again.`);
    show('my-reservations');
  }

  $('#cancelLiveReservation')?.addEventListener('click', () => openCancelModal(getBooking()));
  $('#keepReservation')?.addEventListener('click', closeCancelModal);
  $('#confirmCancelReservation')?.addEventListener('click', () => { if (cancelTargetId) cancelReservation(cancelTargetId); });
  $('#cancelModal')?.addEventListener('click', e => { if (e.target.id === 'cancelModal') closeCancelModal(); });

  function waitForAck(requestId) {
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(requestId);
        reject(new Error('No response from the physical locker. The MQTT command was sent, but the ESP32 did not acknowledge it.'));
      }, Number(cfg.mqtt.ackTimeoutMs || 7000));
      pendingAcks.set(requestId,{resolve,reject,timer});
    });
  }

  async function publishUnlock(b, method) {
    if (!cfg.lockers[b.locker]?.mqttEnabled) return { demo:true, topic:mqttTopic(b.locker,'cmd/unlock') };
    const client = await ensureMqttClient();
    const requestId = `REQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(16).slice(2,6)}`;
    const topic = mqttTopic(b.locker, 'cmd/unlock');
    const payload = JSON.stringify({
      requestId,
      bookingId: b.id,
      locker: b.locker,
      source: method.toLowerCase().replace(/\s+/g, '-'),
      reservationPinVerified: method === 'Reservation PIN',
      timestamp: new Date().toISOString(),
      epochMs: Date.now()
    });
    const ackPromise = waitForAck(requestId);
    await publishAsync(client, topic, payload);
    const ack = await ackPromise;
    return { demo:false, topic, ack };
  }

  $('#mobileUnlockOption').addEventListener('click', () => {
    const b = getBooking();
    if (!b) return toast('No active reservation selected.');
    const access = accessAllowedNow(b);
    if (!access.ok) return toast(access.message);
    unlockMethod = 'Mobile';
    beginUnlock();
  });

  $('#pinUnlockOption').addEventListener('click', () => {
    const b = getBooking();
    if (!b) return toast('No active reservation selected.');
    const access = accessAllowedNow(b);
    if (!access.ok) return toast(access.message);
    show('pin-entry');
  });

  function renderPinEntry() {
    enteredPin = '';
    const b = getBooking();
    if (!b) return show('my-reservations');
    const access = accessAllowedNow(b);
    if (!access.ok) { toast(access.message); return show('live-status'); }
    $('#pinLockerLabel').textContent = `Locker ${b.locker}`;
    $('#pinEntryError').textContent = '';
    updatePinDots();
  }

  function updatePinDots() {
    $$('#pinDots i').forEach((dot, i) => dot.classList.toggle('filled', i < enteredPin.length));
    $('#verifyPin').disabled = enteredPin.length !== 4;
  }

  $('#numberPad').addEventListener('click', (e) => {
    const key = e.target.closest('[data-digit]');
    if (!key || enteredPin.length >= 4) return;
    enteredPin += key.dataset.digit;
    $('#pinEntryError').textContent = '';
    updatePinDots();
  });
  $('#pinClear').addEventListener('click', () => { enteredPin = ''; updatePinDots(); });
  $('#pinBackspace').addEventListener('click', () => { enteredPin = enteredPin.slice(0, -1); updatePinDots(); });
  $('#showReservationPin').addEventListener('click', () => {
    const b = getBooking();
    if (b) toast(`Your reservation PIN is ${b.pin}.`);
  });
  $('#verifyPin').addEventListener('click', () => {
    const b = getBooking();
    if (!b) return show('my-reservations');
    if (enteredPin !== b.pin) {
      const err = $('#pinEntryError');
      err.textContent = 'Incorrect reservation PIN. Please try again.';
      err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake');
      enteredPin = ''; updatePinDots(); return;
    }
    unlockMethod = 'Reservation PIN';
    beginUnlock();
  });

  async function beginUnlock() {
    const b = getBooking();
    if (!b) return show('my-reservations');
    const access = accessAllowedNow(b);
    if (!access.ok) { toast(access.message); return show('live-status'); }
    show('unlocking');
    $('#unlockingTitle').textContent = `Opening Locker ${b.locker}…`;
    $('#unlockingMessage').textContent = unlockMethod === 'Mobile'
      ? 'Sending a secure remote unlock request from your active reservation.'
      : 'Reservation PIN verified. Sending the unlock request to your SandLock.';
    $('#unlockTransport').textContent = cfg.lockers[b.locker]?.mqttEnabled ? 'Publishing through HiveMQ and waiting for the ESP32 acknowledgement.' : 'Demo locker • local access simulation.';
    $('#unlockConnectionLabel').textContent = cfg.lockers[b.locker]?.mqttEnabled ? 'Connecting to HiveMQ…' : 'Demo locker active';
    $('#unlockTopicLabel').textContent = mqttTopic(b.locker, 'cmd/unlock');
    ['unlockStep1','unlockStep2','unlockStep3'].forEach((id,i)=>{ const el=$(`#${id}`); el.classList.toggle('active',i===0); el.classList.remove('done'); el.querySelector('b').textContent=i===0?'✓':'•'; });
    await new Promise(r => setTimeout(r, 430));
    $('#unlockStep1').classList.add('done'); $('#unlockStep2').classList.add('active'); $('#unlockStep2').querySelector('b').textContent='…';
    try {
      const result = await publishUnlock(b, unlockMethod);
      $('#unlockConnectionLabel').textContent = result.demo ? 'Demo unlock completed' : 'ESP32 acknowledged the unlock command';
      await new Promise(r => setTimeout(r, result.demo ? 650 : 220));
      $('#unlockStep2').classList.add('done'); $('#unlockStep2').querySelector('b').textContent='✓'; $('#unlockStep3').classList.add('active'); $('#unlockStep3').querySelector('b').textContent='…';
      await new Promise(r => setTimeout(r, 650));
      const list = getBookings();
      const idx = list.findIndex(x => x.id === b.id);
      if (idx >= 0) { const accessedAt = new Date().toISOString(); list[idx].door = 'open'; list[idx].status = 'active'; list[idx].lastAccessAt = accessedAt; list[idx].updatedAt = accessedAt; list[idx].lastAccessMethod = unlockMethod; saveBookings(list); publishCurrentUserState().catch(()=>{}); }
      publishAdminEvent('access', { timestamp:new Date().toISOString(), locker:b.locker, bookingId:b.id, ownerMobile:b.ownerMobile||'', method:unlockMethod, action:'unlock', result:'success', door:'open', source:'user-app' });
      $('#unlockStep3').classList.add('done'); $('#unlockStep3').querySelector('b').textContent='✓';
      await new Promise(r => setTimeout(r, 320));
      renderUnlockSuccess();
      show('unlock-success');
    } catch (err) {
      $('#unlockConnectionLabel').textContent = 'Unable to send unlock command';
      $('#unlockingMessage').textContent = err.message || 'Please check your broker connection and try again.';
      $('#unlockStep2').querySelector('b').textContent='!';
      setTimeout(() => show('unlock-options'), 1800);
    }
  }

  function renderUnlockSuccess() {
    const b = getBooking();
    if (!b) return;
    $('#successLocker').textContent = `Locker ${b.locker}`;
    $('#successMethod').textContent = unlockMethod;
    $('#successTime').textContent = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date());
  }

  $('#endSession').addEventListener('click', async () => {
    const b = getBooking();
    if (!b) return;
    const now = new Date();
    const fee = lateFeeFor(b, now);
    const list = getBookings();
    const idx = list.findIndex(x => x.id === b.id);
    if (idx >= 0) {
      list[idx].status = 'completed';
      list[idx].door = 'closed';
      list[idx].completedAt = now.toISOString();
      list[idx].updatedAt = list[idx].completedAt;
      list[idx].lateFee = fee;
      list[idx].finalTotal = Number((Number(list[idx].total || 0) + fee).toFixed(2));
      saveBookings(list);
      renderMapStatuses(true);
      await publishSharedLockerState(list[idx], false).catch(()=>{});
      await publishCurrentUserState().catch(()=>{});
      publishAdminEvent('reservation/complete', list[idx]);
      if (fee > 0) publishAdminEvent('payment', { bookingId:list[idx].id, ownerMobile:list[idx].ownerMobile||'', type:'Late Fee', amount:fee, status:'due-demo', reference:`LATE-${list[idx].id}` });
    }
    clearReservationOnLocker(b).catch(() => {});
    toast(fee > 0 ? `Reservation completed • Late fee ${fee.toFixed(2)} EGP` : 'Reservation completed on time.');
    setTimeout(() => show('feedback'), 500);
  });

  // Screen 14: reservation history.
  function renderHistory() {
    const list = getBookings().filter(b => ['completed','cancelled'].includes(b.status));
    const host = $('#historyList');
    const empty = $('#historyEmpty');
    host.innerHTML = '';
    empty.style.display = list.length ? 'none' : 'block';
    const hours = list.reduce((sum,b)=>sum+(Number(b.hours)||0),0);
    const spent = list.reduce((sum,b)=>sum+(b.status === 'cancelled' ? 0 : (Number(b.finalTotal ?? b.total)||0)),0);
    $('#historyCount').textContent = list.length;
    $('#historyHours').textContent = Number(hours.toFixed(2));
    $('#historySpent').textContent = spent;
    list.forEach(b => {
      const item = document.createElement('article');
      item.className = 'card history-item';
      const badgeClass = b.status === 'cancelled' ? 'occupied' : 'available';
      const badgeText = b.status === 'cancelled' ? 'Cancelled' : 'Completed';
      item.innerHTML = `
        <div class="history-item-head"><div><span class="section-kicker">${b.zone || 'BEACH ZONE 1'}</span><h3>Locker ${b.locker}</h3></div><span class="status-badge-inline ${badgeClass}">${badgeText}</span></div>
        <div class="history-item-body">
          <div><span>Date</span><strong>${niceDate(b.date)}</strong></div><div><span>Time</span><strong>${b.from} – ${b.to}</strong></div>
          <div><span>Duration</span><strong>${formatBookingDuration(b)}</strong></div><div><span>${b.status === 'cancelled' ? 'Payment' : 'Final amount'}</span><strong>${b.status === 'cancelled' ? 'Refund per policy' : `${Number(b.finalTotal ?? b.total).toFixed(2)} EGP`}</strong></div>
        </div>
        ${Number(b.lateFee||0) > 0 ? `<div class="reservation-late-line">Late fee charged: ${Number(b.lateFee).toFixed(2)} EGP</div>` : ''}
        <div class="history-footer"><span>Access: ${b.lastAccessMethod || 'Reservation'}</span><strong>${badgeText}</strong></div>`;
      host.appendChild(item);
    });
  }

  // Screen 15: profile and settings.
  function initials(name='') {
    return name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase() || 'SL';
  }
  function renderProfile() {
    const user = getUser();
    if (!user) return show('login');
    $('#profileAvatar').textContent = initials(user.name);
    $('#profileName').textContent = user.name || 'SandLock User';
    $('#profilePhone').textContent = `+20 ${user.mobile || '—'}`;
    $('#profilePayment').textContent = user.paymentLast4 ? `•••• •••• •••• ${user.paymentLast4}` : 'No card saved';
    $('#profileNameInput').value = user.name || '';
    $('#profilePhoneInput').value = user.mobile || '';
    $('#profileCardInput').value = '';
    const mqttProfileState = $('#mqttProfileState');
    if (mqttProfileState) mqttProfileState.textContent = mqttClient?.connected ? 'Connected to HiveMQ Cloud • secure WebSocket' : 'HiveMQ configured • connection starts automatically';
    updateNotificationProfileState();
    ensureMqttClient().catch(() => {});
  }

  $('#toggleProfileEdit').addEventListener('click', () => {
    const panel = $('#profileEditPanel');
    panel.hidden = !panel.hidden;
    $('#toggleProfileEdit').textContent = panel.hidden ? 'Edit' : 'Close';
  });
  $('#profilePhoneInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g,'').slice(0,11); });
  $('#profileCardInput').addEventListener('input', e => { const d=e.target.value.replace(/\D/g,'').slice(0,16); e.target.value=d.replace(/(.{4})/g,'$1 ').trim(); });
  $('#saveProfile').addEventListener('click', async () => {
    const user = getUser() || {};
    const previousKey = userIdentityKey(user);
    const previousBookings = getBookings();
    const name = $('#profileNameInput').value.trim();
    const phone = $('#profilePhoneInput').value.replace(/\D/g,'');
    const card = $('#profileCardInput').value.replace(/\D/g,'');
    if (name.length < 2) return $('#profileError').textContent='Please enter your full name.';
    if (phone.length < 10) return $('#profileError').textContent='Please enter a valid mobile number.';
    if (card && card.length !== 16) return $('#profileError').textContent='Replacement card must contain 16 digits.';
    const updated = { ...user, name, mobile: phone };
    if (card) updated.paymentLast4 = card.slice(-4);
    localStorage.setItem('sandlock_user', JSON.stringify(updated));
    const nextKey = userIdentityKey(updated);
    if (nextKey && nextKey !== previousKey) {
      const migrated = previousBookings.map(b => ({ ...b, ownerName:name, ownerMobile:phone, updatedAt:new Date().toISOString() }));
      localStorage.setItem(bookingsStorageKey(updated), JSON.stringify(migrated));
      accountSyncReady = false;
      activeUserSyncTopic = '';
      try {
        if (previousKey && mqttClient?.connected) await publishAsync(mqttClient, appSyncTopic(`users/${previousKey}`), '', { retain:true });
        await syncCurrentAccount({ publishAdmin:true });
      } catch (err) { console.warn('SandLock profile identity sync:', err.message); }
    } else {
      publishUserSnapshot();
      publishCurrentUserState().catch(()=>{});
    }
    $('#profileError').textContent=''; $('#profileEditPanel').hidden=true; $('#toggleProfileEdit').textContent='Edit'; renderProfile(); toast('Profile updated.');
  });
  $('#logoutButton').addEventListener('click', () => {
    localStorage.removeItem('sandlock_user');
    accountSyncReady = false;
    activeUserSyncTopic = '';
    if (userStatePublishTimer) { clearTimeout(userStatePublishTimer); userStatePublishTimer = null; }
    if (mqttClient) { try { mqttClient.end(true); } catch {} mqttClient = null; }
    if (phoneTimeTimer) { clearInterval(phoneTimeTimer); phoneTimeTimer = null; }
    show('login'); toast('Signed out from this device.');
  });



  // Screen 16: payment method.
  function formatMasked(last4) {
    return last4 ? `•••• •••• •••• ${last4}` : '•••• •••• •••• ----';
  }
  function renderPaymentMethod() {
    const user = getUser();
    if (!user) return show('login');
    $('#paymentCardDisplay').textContent = formatMasked(user.paymentLast4);
    $('#paymentCardHolder').textContent = (user.name || 'SANDLOCK USER').toUpperCase();
    $('#paymentCardInput').value = '';
    $('#paymentMethodError').textContent = '';
    $('#deletePaymentMethod').disabled = !user.paymentLast4;
  }
  $('#paymentCardInput').addEventListener('input', e => {
    const digits = e.target.value.replace(/\D/g,'').slice(0,16);
    e.target.value = digits.replace(/(.{4})/g,'$1 ').trim();
  });
  $('#savePaymentMethod').addEventListener('click', () => {
    const user = getUser();
    if (!user) return show('login');
    const digits = $('#paymentCardInput').value.replace(/\D/g,'');
    if (digits.length !== 16) return $('#paymentMethodError').textContent = 'Please enter exactly 16 digits for the demo card.';
    user.paymentLast4 = digits.slice(-4);
    localStorage.setItem('sandlock_user', JSON.stringify(user));
    renderPaymentMethod(); renderProfile(); toast('Payment method updated.');
  });
  $('#deletePaymentMethod').addEventListener('click', () => {
    const user = getUser();
    if (!user) return;
    delete user.paymentLast4;
    localStorage.setItem('sandlock_user', JSON.stringify(user));
    renderPaymentMethod(); renderProfile(); toast('Saved payment method removed.');
  });

  // Screen 18: local prototype support requests.
  function renderSupport() {
    $('#supportStatus').hidden = true;
    $('#supportError').textContent = '';
  }
  $('#supportLocker').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,4); });
  $('#supportForm').addEventListener('submit', e => {
    e.preventDefault();
    const message = $('#supportMessage').value.trim();
    const locker = $('#supportLocker').value.trim();
    const category = $('#supportCategory').value;
    if (message.length < 10) return $('#supportError').textContent = 'Please describe the issue in at least 10 characters.';
    const tickets = JSON.parse(localStorage.getItem('sandlock_support_tickets') || '[]');
    const user = getUser();
    tickets.unshift({
      id: `SUP-${Date.now().toString(36).toUpperCase()}`,
      category, locker, message,
      userName: user?.name || '', userMobile: user?.mobile || '',
      createdAt: new Date().toISOString(), status: 'saved-locally'
    });
    localStorage.setItem('sandlock_support_tickets', JSON.stringify(tickets));
    $('#supportError').textContent = '';
    $('#supportForm').reset();
    $('#supportStatus').hidden = false;
    toast('Support request saved locally.');
  });

  // Screen 19: rating and feedback.
  let currentRating = 0;
  function latestCompletedBooking() {
    return getBookings().filter(b => b.status === 'completed').sort((a,b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt))[0] || null;
  }
  function renderFeedback() {
    const b = selectedBookingId ? getBookings().find(x => x.id === selectedBookingId) : latestCompletedBooking();
    const summary = $('#feedbackBookingSummary');
    if (b) {
      selectedBookingId = b.id;
      summary.innerHTML = `<span>Latest session</span><strong>Locker ${b.locker} • ${niceDate(b.date)} • ${b.from}–${b.to}</strong>`;
    } else {
      summary.innerHTML = '<span>Latest session</span><strong>No completed reservation yet</strong>';
    }
    currentRating = 0;
    $('#feedbackComment').value = '';
    $('#feedbackError').textContent = '';
    $('#feedbackThanks').hidden = true;
    $('.feedback-card').hidden = false;
    $$('#starRating button').forEach(btn => btn.classList.remove('selected'));
    $('#ratingLabel').textContent = 'Tap a star to rate your experience';
  }
  const ratingWords = {1:'Needs improvement',2:'Fair',3:'Good',4:'Very good',5:'Excellent'};
  $('#starRating').addEventListener('click', e => {
    const btn = e.target.closest('[data-rating]');
    if (!btn) return;
    currentRating = Number(btn.dataset.rating);
    $$('#starRating button').forEach(b => b.classList.toggle('selected', Number(b.dataset.rating) <= currentRating));
    $('#ratingLabel').textContent = ratingWords[currentRating];
    $('#feedbackError').textContent = '';
  });
  $('#submitFeedback').addEventListener('click', () => {
    if (!currentRating) return $('#feedbackError').textContent = 'Please choose a star rating before submitting.';
    const b = selectedBookingId ? getBookings().find(x => x.id === selectedBookingId) : latestCompletedBooking();
    const entries = JSON.parse(localStorage.getItem('sandlock_feedback') || '[]');
    entries.unshift({
      id: `FB-${Date.now().toString(36).toUpperCase()}`,
      bookingId: b?.id || null,
      locker: b?.locker || null,
      rating: currentRating,
      comment: $('#feedbackComment').value.trim(),
      ownerMobile: b?.ownerMobile || getUser()?.mobile || '',
      createdAt: new Date().toISOString()
    });
    localStorage.setItem('sandlock_feedback', JSON.stringify(entries));
    publishAdminEvent('feedback', entries[0] || entries[entries.length-1] || {});
    $('#feedbackError').textContent = '';
    $('.feedback-card').hidden = true;
    $('#feedbackThanks').hidden = false;
    toast('Thanks for your feedback.');
  });

  // Reservation reminders, 15-minute notification and automatic late-fee refresh.
  function updateNotificationProfileState() {
    const el = $('#notificationProfileState');
    if (!el) return;
    if (!('Notification' in window)) return el.textContent = 'Browser notifications are not supported here; in-app reminders remain active.';
    if (Notification.permission === 'granted') el.textContent = `Enabled • ${cfg.policy.reminderMinutesBeforeEnd}-minute reminder active.`;
    else if (Notification.permission === 'denied') el.textContent = 'Blocked by browser • in-app reminder remains active.';
    else el.textContent = `Tap to enable the ${cfg.policy.reminderMinutesBeforeEnd}-minute reminder.`;
  }

  async function requestReminderPermission(showResult=true) {
    if (!('Notification' in window)) {
      if (showResult) toast('System notifications are not supported in this browser. In-app reminders are still active.');
      updateNotificationProfileState();
      return 'unsupported';
    }
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      if (showResult) toast(Notification.permission === 'granted' ? 'Reservation reminders are enabled.' : 'Notifications are blocked by the browser; in-app reminders remain active.');
      updateNotificationProfileState();
      return Notification.permission;
    }
    try {
      const result = await Notification.requestPermission();
      if (showResult) toast(result === 'granted' ? '15-minute reservation reminder enabled.' : 'In-app reminders will be used instead.');
      updateNotificationProfileState();
      return result;
    } catch {
      updateNotificationProfileState();
      return 'default';
    }
  }

  $('#notificationSettings')?.addEventListener('click', () => requestReminderPermission(true));

  function sendEndReminder(b) {
    const title = `SandLock • Locker ${b.locker}`;
    const body = `Your reservation ends in ${cfg.policy.reminderMinutesBeforeEnd} minutes. Please collect your belongings to avoid the ${cfg.policy.lateFeeMultiplier}× overtime charge.`;
    if ('Notification' in window && Notification.permission === 'granted') {
      if (window.SandLockPWA?.showNotification) {
        window.SandLockPWA.showNotification(title, { body, tag:`sandlock-reminder-${b.id}`, data:{ bookingId:b.id, screen:'my-reservations' } }).catch(()=>{});
      } else {
        try { new Notification(title, { body, tag:`sandlock-reminder-${b.id}` }); } catch {}
      }
    }
    toast(body);
  }

  function policyTick() {
    const now = new Date();
    const list = getBookings();
    let changed = false;
    list.forEach(b => {
      if (['completed','cancelled'].includes(b.status)) return;
      const end = bookingDateTime(b,'end');
      if (!end) return;
      const msLeft = end - now;
      const reminderWindow = Number(cfg.policy.reminderMinutesBeforeEnd || 15) * 60000;
      if (msLeft > 0 && msLeft <= reminderWindow && !b.reminderSent) {
        b.reminderSent = true;
        b.reminderSentAt = now.toISOString();
        changed = true;
        sendEndReminder(b);
      }
      const phase = bookingPhase(b, now);
      if (phase === 'active' && b.status !== 'active') { b.status = 'active'; changed = true; }
      if (phase === 'overdue' && b.status !== 'overdue') { b.status = 'overdue'; changed = true; }
      if (phase === 'overdue') {
        const fee = lateFeeFor(b, now);
        if (Math.abs(Number(b.lateFeeCurrent || 0) - fee) >= .01) { b.lateFeeCurrent = fee; changed = true; }
      }
    });
    if (changed) saveBookings(list);
    const currentScreen = screens.find(x => x.classList.contains('active'))?.dataset.screen;
    if (currentScreen === 'live-status') renderLiveStatus();
    if (currentScreen === 'my-reservations') renderReservations();
    if (currentScreen === 'map') renderMapStatuses(true);
    if (currentScreen === 'details') refreshDetailsStatus(selectedLocker);
  }

  if (policyTimer) clearInterval(policyTimer);
  policyTimer = setInterval(policyTick, 1000);
  policyTick();

  // Persistent sign-in: a saved user returns directly to the map until they explicitly log out.
  if (getUser()) {
    migrateLegacyBookingsForUser(getUser());
    show('map');
    syncCurrentAccount({ publishAdmin:true }).catch(err => console.warn('SandLock MQTT/account startup:', err.message));
    updateNotificationProfileState();
  }

  // Development preview helper: e.g. ?screen=map while testing on laptop.
  const previewScreen = new URLSearchParams(location.search).get('screen');
  if (previewScreen && screens.some(s => s.dataset.screen === previewScreen)) show(previewScreen);

  // Exposed for Settings + future integration.
  window.SandLockDemo = {
    clearProfile() { localStorage.removeItem('sandlock_user'); },
    clearPendingBooking() { localStorage.removeItem('sandlock_pending_booking'); },
    clearBookings() { localStorage.removeItem(bookingsStorageKey()); },
    clearSupportTickets() { localStorage.removeItem('sandlock_support_tickets'); },
    clearFeedback() { localStorage.removeItem('sandlock_feedback'); },
    mqttConfig: cfg.mqtt,
    getBookings,
    effectiveLockerStatus,
    bookingPhase,
    renderMapStatuses,
    userIdentityKey,
    syncCurrentAccount,
    publishCurrentUserState,
    sharedLockerStates
  };
})();
