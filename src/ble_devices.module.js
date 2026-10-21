/**
 * @file ble_devices.module.js
 *
 * Web Bluetooth drivers for smart bike trainers, spin bikes, power meters, speed/cadence sensors
 * and heart-rate monitors. No UI, no dependencies.
 *
 * Supported Bluetooth SIG profiles
 *   - Fitness Machine Service   (FTMS, 0x1826) – power, cadence, speed, resistance + trainer control
 *   - Cycling Power Service     (CPS,  0x1818) – power, cadence and speed from revolution data
 *   - Cycling Speed and Cadence (CSC,  0x1816) – cadence and speed from revolution data
 *   - Heart Rate Service        (HRS,  0x180D) – heart rate, RR intervals, energy expended
 *   - Battery (0x180F) and Device Information (0x180A), when the device exposes them
 *
 * Specifications: https://www.bluetooth.com/specifications/specs/ (FTMS 1.0, CPS 1.1, CSCS 1.0, HRS 1.0)
 * and the GATT Specification Supplement for field formats.
 *
 * Units used throughout: power W, cadence rpm, speed km/h, distance m, energy kJ, heart rate bpm,
 * RR intervals ms, timestamps ms since Unix epoch (Date.now()).
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** 16-bit GATT service UUIDs. */
export const SERVICE = Object.freeze({
    FITNESS_MACHINE: 0x1826,
    CYCLING_POWER: 0x1818,
    CYCLING_SPEED_AND_CADENCE: 0x1816,
    HEART_RATE: 0x180D,
    BATTERY: 0x180F,
    DEVICE_INFORMATION: 0x180A,
});

/** 16-bit GATT characteristic UUIDs. */
export const CHARACTERISTIC = Object.freeze({
    // Fitness Machine
    FITNESS_MACHINE_FEATURE: 0x2ACC,
    INDOOR_BIKE_DATA: 0x2AD2,
    SUPPORTED_SPEED_RANGE: 0x2AD4,
    SUPPORTED_INCLINATION_RANGE: 0x2AD5,
    SUPPORTED_RESISTANCE_LEVEL_RANGE: 0x2AD6,
    SUPPORTED_POWER_RANGE: 0x2AD8,
    FITNESS_MACHINE_CONTROL_POINT: 0x2AD9,
    FITNESS_MACHINE_STATUS: 0x2ADA,
    // Cycling Power
    CYCLING_POWER_MEASUREMENT: 0x2A63,
    CYCLING_POWER_FEATURE: 0x2A65,
    // Cycling Speed and Cadence
    CSC_MEASUREMENT: 0x2A5B,
    CSC_FEATURE: 0x2A5C,
    // Heart Rate
    HEART_RATE_MEASUREMENT: 0x2A37,
    BODY_SENSOR_LOCATION: 0x2A38,
    // Battery & Device Information
    BATTERY_LEVEL: 0x2A19,
    MODEL_NUMBER: 0x2A24,
    FIRMWARE_REVISION: 0x2A26,
    HARDWARE_REVISION: 0x2A27,
    SOFTWARE_REVISION: 0x2A28,
    MANUFACTURER_NAME: 0x2A29,
});

/** Values of `device.state`. */
export const CONNECTION_STATE = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
});

/** Fitness Machine Control Point op codes (FTMS 1.0, section 4.16). */
export const FTMS_OPCODE = Object.freeze({
    REQUEST_CONTROL: 0x00,
    RESET: 0x01,
    SET_TARGET_SPEED: 0x02,
    SET_TARGET_INCLINATION: 0x03,
    SET_TARGET_RESISTANCE_LEVEL: 0x04,
    SET_TARGET_POWER: 0x05,
    SET_TARGET_HEART_RATE: 0x06,
    START_OR_RESUME: 0x07,
    STOP_OR_PAUSE: 0x08,
    SET_INDOOR_BIKE_SIMULATION: 0x11,
    SET_WHEEL_CIRCUMFERENCE: 0x12,
    SPIN_DOWN_CONTROL: 0x13,
    SET_TARGETED_CADENCE: 0x14,
    RESPONSE_CODE: 0x80,
});

const FTMS_RESULT = Object.freeze({
    0x01: 'success',
    0x02: 'op-code-not-supported',
    0x03: 'invalid-parameter',
    0x04: 'operation-failed',
    0x05: 'control-not-permitted',
});

const FTMS_STATUS = Object.freeze({
    0x01: 'reset',
    0x02: 'stopped-or-paused',
    0x03: 'stopped-by-safety-key',
    0x04: 'started-or-resumed',
    0x05: 'target-speed-changed',
    0x06: 'target-incline-changed',
    0x07: 'target-resistance-level-changed',
    0x08: 'target-power-changed',
    0x09: 'target-heart-rate-changed',
    0x12: 'indoor-bike-simulation-parameters-changed',
    0x13: 'wheel-circumference-changed',
    0x14: 'spin-down-status',
    0x15: 'targeted-cadence-changed',
    0xFF: 'control-permission-lost',
});

// Bit names of the feature characteristics, in bit order.
const FTMS_MACHINE_FEATURE_BITS = [
    'averageSpeed', 'cadence', 'totalDistance', 'inclination', 'elevationGain', 'pace', 'stepCount',
    'resistanceLevel', 'strideCount', 'expendedEnergy', 'heartRateMeasurement', 'metabolicEquivalent',
    'elapsedTime', 'remainingTime', 'powerMeasurement', 'forceOnBeltAndPowerOutput', 'userDataRetention',
];
const FTMS_TARGET_FEATURE_BITS = [
    'speedTarget', 'inclinationTarget', 'resistanceTarget', 'powerTarget', 'heartRateTarget',
    'targetedExpendedEnergy', 'targetedStepNumber', 'targetedStrideNumber', 'targetedDistance',
    'targetedTrainingTime', 'targetedTimeInTwoHeartRateZones', 'targetedTimeInThreeHeartRateZones',
    'targetedTimeInFiveHeartRateZones', 'indoorBikeSimulation', 'wheelCircumference', 'spinDownControl',
    'targetedCadence',
];
const CYCLING_POWER_FEATURE_BITS = [
    'pedalPowerBalance', 'accumulatedTorque', 'wheelRevolutionData', 'crankRevolutionData',
    'extremeMagnitudes', 'extremeAngles', 'topAndBottomDeadSpotAngles', 'accumulatedEnergy',
    'offsetCompensationIndicator', 'offsetCompensation', 'measurementContentMasking',
    'multipleSensorLocations', 'crankLengthAdjustment', 'chainLengthAdjustment', 'chainWeightAdjustment',
    'spanLengthAdjustment', 'sensorMeasurementContextTorque', 'instantaneousMeasurementDirection',
    'factoryCalibrationDate', 'enhancedOffsetCompensation',
];
const CSC_FEATURE_BITS = ['wheelRevolutionData', 'crankRevolutionData', 'multipleSensorLocations'];

const BODY_SENSOR_LOCATIONS = ['other', 'chest', 'wrist', 'finger', 'hand', 'ear-lobe', 'foot'];

// ---------------------------------------------------------------------------------------------
// Errors & helpers
// ---------------------------------------------------------------------------------------------

/** Thrown when a trainer control command is unsupported, rejected or times out. */
export class BleControlError extends Error {
    /**
     * @param {string} message
     * @param {{opCode?: number, resultCode?: number}} [details]
     */
    constructor(message, { opCode = null, resultCode = null } = {}) {
        super(message);
        this.name = 'BleControlError';
        this.opCode = opCode;
        this.resultCode = resultCode;
        this.result = resultCode == null ? null : (FTMS_RESULT[resultCode] ?? 'unknown');
    }
}

/** @returns {boolean} true when the browser exposes the Web Bluetooth API. */
export function isBluetoothAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/** @returns {Promise<boolean>} true when Web Bluetooth exists and a Bluetooth adapter is available. */
export async function isBluetoothEnabled() {
    if (!isBluetoothAvailable()) return false;
    try {
        return await navigator.bluetooth.getAvailability();
    } catch {
        return true; // getAvailability() is missing in some implementations; assume enabled.
    }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const int16 = (value) => {
    const v = clamp(Math.round(value), -32768, 32767);
    return [v & 0xFF, (v >> 8) & 0xFF];
};
const uint16 = (value) => {
    const v = clamp(Math.round(value), 0, 0xFFFF);
    return [v & 0xFF, v >> 8];
};
const uint8 = (value) => [clamp(Math.round(value), 0, 0xFF)];

function decodeBits(value, names) {
    const out = {};
    names.forEach((name, bit) => { out[name] = ((value >>> bit) & 1) === 1; });
    return out;
}

function deepFreeze(object) {
    for (const value of Object.values(object)) {
        if (value && typeof value === 'object') deepFreeze(value);
    }
    return Object.freeze(object);
}

/** Little-endian reader over a DataView. Reading past the end throws a RangeError. */
class ByteReader {
    constructor(view) {
        this.view = view;
        this.offset = 0;
    }
    get remaining() { return this.view.byteLength - this.offset; }
    u8() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
    u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    s16() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
    u24() { const v = this.view.getUint16(this.offset, true) | (this.view.getUint8(this.offset + 2) << 16); this.offset += 3; return v; }
    u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
}

function toDataView(data) {
    if (data instanceof DataView) return data;
    if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new DataView(data);
    if (Array.isArray(data)) return new DataView(Uint8Array.from(data).buffer);
    throw new TypeError('Expected a DataView, ArrayBuffer, typed array or array of bytes');
}

/** Runs a parser; a truncated packet yields the fields read so far plus `truncated: true`. */
function parsePacket(data, parser) {
    const reader = new ByteReader(toDataView(data));
    const out = {};
    try {
        parser(reader, out);
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        out.truncated = true;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Packet parsers (pure functions – accept DataView, ArrayBuffer, typed array or number[])
// ---------------------------------------------------------------------------------------------

/** Cycling Power Measurement (0x2A63). */
export function parseCyclingPowerMeasurement(data) {
    return parsePacket(data, (r, out) => {
        const flags = out.flags = r.u16();
        out.power = r.s16();
        if (flags & 0x0001) {
            out.pedalPowerBalance = r.u8() / 2; // %
            out.pedalPowerBalanceReference = (flags & 0x0002) ? 'left' : 'unknown';
        }
        if (flags & 0x0004) {
            out.accumulatedTorque = r.u16() / 32; // Nm
            out.accumulatedTorqueSource = (flags & 0x0008) ? 'crank' : 'wheel';
        }
        if (flags & 0x0010) {
            out.wheelRevolutions = r.u32();
            out.lastWheelEventTime = r.u16(); // 1/2048 s
        }
        if (flags & 0x0020) {
            out.crankRevolutions = r.u16();
            out.lastCrankEventTime = r.u16(); // 1/1024 s
        }
        if (flags & 0x0040) {
            out.maxForce = r.s16(); // N
            out.minForce = r.s16();
        }
        if (flags & 0x0080) {
            out.maxTorque = r.s16() / 32; // Nm
            out.minTorque = r.s16() / 32;
        }
        if (flags & 0x0100) {
            const b0 = r.u8(), b1 = r.u8(), b2 = r.u8(); // two packed uint12, degrees
            out.maxAngle = b0 | ((b1 & 0x0F) << 8);
            out.minAngle = (b1 >> 4) | (b2 << 4);
        }
        if (flags & 0x0200) out.topDeadSpotAngle = r.u16();
        if (flags & 0x0400) out.bottomDeadSpotAngle = r.u16();
        if (flags & 0x0800) out.accumulatedEnergy = r.u16(); // kJ
        out.offsetCompensationIndicator = (flags & 0x1000) !== 0;
    });
}

/** Indoor Bike Data (0x2AD2, FTMS). Large packets may be split; each part only contains some fields. */
export function parseIndoorBikeData(data) {
    return parsePacket(data, (r, out) => {
        const flags = out.flags = r.u16();
        out.moreData = (flags & 0x0001) !== 0;
        if (!(flags & 0x0001)) out.speed = r.u16() / 100; // km/h (present when "More Data" is 0)
        if (flags & 0x0002) out.averageSpeed = r.u16() / 100;
        if (flags & 0x0004) out.cadence = r.u16() / 2; // rpm
        if (flags & 0x0008) out.averageCadence = r.u16() / 2;
        if (flags & 0x0010) out.totalDistance = r.u24(); // m
        if (flags & 0x0020) out.resistanceLevel = r.s16(); // unitless, as reported by the device
        if (flags & 0x0040) out.power = r.s16(); // W
        if (flags & 0x0080) out.averagePower = r.s16();
        if (flags & 0x0100) {
            out.totalEnergy = r.u16(); // kcal (0xFFFF = not available)
            out.energyPerHour = r.u16();
            out.energyPerMinute = r.u8();
        }
        if (flags & 0x0200) out.heartRate = r.u8();
        if (flags & 0x0400) out.metabolicEquivalent = r.u8() / 10;
        if (flags & 0x0800) out.elapsedTime = r.u16(); // s
        if (flags & 0x1000) out.remainingTime = r.u16(); // s
    });
}

/** CSC Measurement (0x2A5B). */
export function parseCscMeasurement(data) {
    return parsePacket(data, (r, out) => {
        const flags = out.flags = r.u8();
        if (flags & 0x01) {
            out.wheelRevolutions = r.u32();
            out.lastWheelEventTime = r.u16(); // 1/1024 s
        }
        if (flags & 0x02) {
            out.crankRevolutions = r.u16();
            out.lastCrankEventTime = r.u16(); // 1/1024 s
        }
    });
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRateMeasurement(data) {
    return parsePacket(data, (r, out) => {
        const flags = out.flags = r.u8();
        out.heartRate = (flags & 0x01) ? r.u16() : r.u8();
        const contact = (flags >> 1) & 0b11;
        out.contactDetected = contact === 3 ? true : contact === 2 ? false : null; // null = not supported
        if (flags & 0x08) out.energyExpended = r.u16(); // kJ
        out.rrIntervals = [];
        if (flags & 0x10) {
            while (r.remaining >= 2) out.rrIntervals.push(r.u16() * 1000 / 1024); // ms
        }
    });
}

/** Fitness Machine Feature (0x2ACC). */
export function parseFitnessMachineFeature(data) {
    return parsePacket(data, (r, out) => {
        out.machine = decodeBits(r.u32(), FTMS_MACHINE_FEATURE_BITS);
        out.target = decodeBits(r.u32(), FTMS_TARGET_FEATURE_BITS);
    });
}

/** Cycling Power Feature (0x2A65). */
export function parseCyclingPowerFeature(data) {
    return parsePacket(data, (r, out) => Object.assign(out, decodeBits(r.u32(), CYCLING_POWER_FEATURE_BITS)));
}

/** CSC Feature (0x2A5C). */
export function parseCscFeature(data) {
    return parsePacket(data, (r, out) => Object.assign(out, decodeBits(r.u16(), CSC_FEATURE_BITS)));
}

/**
 * FTMS "Supported ... Range" characteristics (0x2AD4 – 0x2AD8): min, max, minimum increment.
 * @param {*} data
 * @param {{signed?: boolean, divisor?: number}} [format]
 */
export function parseSupportedRange(data, { signed = false, divisor = 1 } = {}) {
    return parsePacket(data, (r, out) => {
        out.min = (signed ? r.s16() : r.u16()) / divisor;
        out.max = (signed ? r.s16() : r.u16()) / divisor;
        out.increment = r.u16() / divisor;
    });
}

// ---------------------------------------------------------------------------------------------
// Revolution counter → rate conversion (shared by CPS and CSC)
// ---------------------------------------------------------------------------------------------

/**
 * Converts cumulative revolution counters and "last event time" stamps into a rotation rate.
 * Handles counter roll-over, duplicated packets (no new revolution) and stopping (rate decays to
 * 0 after `staleTimeout` ms without a new revolution).
 */
export class RevolutionCounter {
    #revolutionModulo;
    #ticksPerSecond;
    #staleTimeout;
    #revolutions = null;
    #ticks = null;
    #lastEventAt = null;
    #rate = null;

    /**
     * @param {{revolutionBits: number, ticksPerSecond: number, staleTimeout?: number}} options
     */
    constructor({ revolutionBits, ticksPerSecond, staleTimeout = 3000 }) {
        this.#revolutionModulo = 2 ** revolutionBits;
        this.#ticksPerSecond = ticksPerSecond;
        this.#staleTimeout = staleTimeout;
    }

    /** Last computed rate in revolutions per second, or null before the first full measurement. */
    get rate() { return this.#rate; }

    /**
     * @param {number} revolutions cumulative revolution count from the packet
     * @param {number} eventTime   last event time from the packet (uint16 ticks)
     * @param {number} [now]       local time of reception, ms
     * @returns {{rate: number|null, revolutions: number}} rate in rev/s and new revolutions since last call
     */
    update(revolutions, eventTime, now = Date.now()) {
        if (this.#revolutions === null) {
            this.#store(revolutions, eventTime, now);
            return { rate: this.#rate, revolutions: 0 };
        }
        const deltaRevolutions = (revolutions - this.#revolutions + this.#revolutionModulo) % this.#revolutionModulo;
        const deltaTicks = (eventTime - this.#ticks + 0x10000) % 0x10000;
        const sinceLastEvent = now - this.#lastEventAt;

        if (deltaRevolutions === 0) {
            if (sinceLastEvent > this.#staleTimeout) this.#rate = 0;
            return { rate: this.#rate, revolutions: 0 };
        }

        this.#store(revolutions, eventTime, now);
        const maxPlausible = 50 * (sinceLastEvent / 1000 + 1); // 50 rev/s ≈ 3000 rpm / 380 km/h
        if (deltaRevolutions > maxPlausible) {
            return { rate: this.#rate, revolutions: 0 }; // counter reset or garbage: re-baseline
        }
        const tickRollover = 0x10000 / this.#ticksPerSecond * 1000;
        if (deltaTicks > 0 && sinceLastEvent < tickRollover) {
            this.#rate = deltaRevolutions / (deltaTicks / this.#ticksPerSecond);
        }
        return { rate: this.#rate, revolutions: deltaRevolutions };
    }

    reset() {
        this.#revolutions = this.#ticks = this.#lastEventAt = this.#rate = null;
    }

    #store(revolutions, eventTime, now) {
        this.#revolutions = revolutions;
        this.#ticks = eventTime;
        this.#lastEventAt = now;
    }
}

// ---------------------------------------------------------------------------------------------
// Device base classes
// ---------------------------------------------------------------------------------------------

/**
 * Minimal shared behaviour for every device (real or simulated): connection state, event helpers
 * and the timestamp of the latest data.
 *
 * Events (use `device.on(type, fn)` or `addEventListener`; payload is `event.detail`):
 *   'statechange' {state}, 'connect', 'disconnect' {expected}, 'data' (snapshot), 'error' (Error)
 */
export class DeviceBase extends EventTarget {
    #state = CONNECTION_STATE.DISCONNECTED;
    #timestamp = null;

    /** @returns {'disconnected'|'connecting'|'connected'} */
    get state() { return this.#state; }
    get isConnected() { return this.#state === CONNECTION_STATE.CONNECTED; }
    get isConnecting() { return this.#state === CONNECTION_STATE.CONNECTING; }
    /** Time (ms since epoch) of the most recent data notification, or null. */
    get timestamp() { return this.#timestamp; }

    /**
     * Subscribe to an event. The listener receives `event.detail` first and the raw event second.
     * @returns {() => void} call to unsubscribe
     */
    on(type, listener) {
        const handler = (event) => listener(event.detail, event);
        this.addEventListener(type, handler);
        return () => this.removeEventListener(type, handler);
    }

    /** @protected */
    _setState(state) {
        if (state === this.#state) return;
        this.#state = state;
        this._emit('statechange', { state });
    }

    /** @protected */
    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    /** @protected Marks that fresh data arrived. */
    _touch(now = Date.now()) {
        this.#timestamp = now;
    }

    /** @protected */
    _clearTimestamp() {
        this.#timestamp = null;
    }
}

/**
 * Base class for Web Bluetooth devices. Handles the device chooser, GATT connection, automatic
 * reconnection, notification subscriptions, battery level and device information.
 *
 * Subclasses implement:
 *   static requestOptions()          → options for navigator.bluetooth.requestDevice()
 *   async _onConnected(server)       → discover services and subscribe (throw to abort connecting)
 *   _onDisconnected()                → reset live values
 */
export class BleDevice extends DeviceBase {
    #device = null;
    #info = {};
    #batteryLevel = null;
    #opening = false;
    #userDisconnect = false;
    #reconnectAttempt = 0;
    #reconnectTimer = null;
    #cleanups = [];
    #onGattDisconnected = () => this.#handleGattDisconnected();

    /**
     * @param {{autoReconnect?: boolean, reconnectAttempts?: number}} [options]
     */
    constructor(options = {}) {
        super();
        this.options = { autoReconnect: true, reconnectAttempts: 5, ...options };
    }

    /** Override in subclasses. */
    static requestOptions() {
        throw new Error(`${this.name} must implement static requestOptions()`);
    }

    /** The underlying Web Bluetooth `BluetoothDevice`, or null. */
    get device() { return this.#device; }
    get name() { return this.#device?.name ?? null; }
    get id() { return this.#device?.id ?? null; }
    /** {manufacturer, model, hardwareRevision, firmwareRevision, softwareRevision} where readable. */
    get info() { return this.#info; }
    /** Battery level in %, or null when unknown. */
    get batteryLevel() { return this.#batteryLevel; }

    /**
     * Open the browser's device chooser (must be called from a user gesture such as a click) and
     * connect. Pass `{device}` to connect to an already known BluetoothDevice without a chooser.
     * @param {{device?: BluetoothDevice}} [options]
     * @returns {Promise<this>}
     */
    async connect({ device = null } = {}) {
        if (this.state !== CONNECTION_STATE.DISCONNECTED || this.#reconnectTimer) this.disconnect();
        if (!device) {
            if (!isBluetoothAvailable()) {
                throw new Error('Web Bluetooth is not available. Use a Chromium-based browser over https:// or localhost.');
            }
            device = await navigator.bluetooth.requestDevice(this.constructor.requestOptions());
        }
        if (this.#device !== device) {
            this.#device?.removeEventListener('gattserverdisconnected', this.#onGattDisconnected);
            device.addEventListener('gattserverdisconnected', this.#onGattDisconnected);
            this.#device = device;
        }
        this.#reconnectAttempt = 0;
        await this.#open();
        return this;
    }

    /** Reconnect to the previously selected device without showing the chooser. */
    async reconnect() {
        if (!this.#device) throw new Error('No device has been selected yet; call connect() first.');
        return this.connect({ device: this.#device });
    }

    /** Disconnect on purpose (no automatic reconnection). */
    disconnect() {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
        this.#userDisconnect = true;
        const wasConnected = this.state !== CONNECTION_STATE.DISCONNECTED;
        this.#teardown();
        if (this.#device?.gatt?.connected) this.#device.gatt.disconnect();
        if (wasConnected) this._emit('disconnect', { expected: true });
    }

    async #open() {
        this.#userDisconnect = false;
        this.#opening = true;
        this._setState(CONNECTION_STATE.CONNECTING);
        try {
            const server = await this.#device.gatt.connect();
            await this.#readCommonServices(server);
            await this._onConnected(server);
            this.#opening = false;
            this._setState(CONNECTION_STATE.CONNECTED);
            this._emit('connect', { name: this.name });
        } catch (error) {
            this.#opening = false;
            this.#teardown();
            if (this.#device?.gatt?.connected) this.#device.gatt.disconnect();
            throw error;
        }
    }

    #handleGattDisconnected() {
        if (this.#opening || this.state === CONNECTION_STATE.DISCONNECTED) return;
        const expected = this.#userDisconnect;
        this.#teardown();
        this._emit('disconnect', { expected });
        if (!expected && this.options.autoReconnect) this.#scheduleReconnect();
    }

    #scheduleReconnect() {
        if (this.#reconnectAttempt >= this.options.reconnectAttempts) {
            this._emit('reconnectfailed', { attempts: this.#reconnectAttempt });
            return;
        }
        const delay = Math.min(1000 * 2 ** this.#reconnectAttempt, 15000);
        this.#reconnectAttempt++;
        this._emit('reconnecting', { attempt: this.#reconnectAttempt, delay });
        this.#reconnectTimer = setTimeout(async () => {
            this.#reconnectTimer = null;
            try {
                await this.#open();
                this.#reconnectAttempt = 0;
            } catch (error) {
                this._emit('error', error);
                if (!this.#userDisconnect) this.#scheduleReconnect();
            }
        }, delay);
    }

    #teardown() {
        for (const cleanup of this.#cleanups.splice(0)) cleanup();
        this.#batteryLevel = null;
        this._clearTimestamp();
        this._onDisconnected();
        this._setState(CONNECTION_STATE.DISCONNECTED);
    }

    async #readCommonServices(server) {
        const info = await this._getService(server, SERVICE.DEVICE_INFORMATION);
        this.#info = {};
        if (info) {
            const decoder = new TextDecoder();
            const fields = {
                manufacturer: CHARACTERISTIC.MANUFACTURER_NAME,
                model: CHARACTERISTIC.MODEL_NUMBER,
                hardwareRevision: CHARACTERISTIC.HARDWARE_REVISION,
                firmwareRevision: CHARACTERISTIC.FIRMWARE_REVISION,
                softwareRevision: CHARACTERISTIC.SOFTWARE_REVISION,
            };
            for (const [key, uuid] of Object.entries(fields)) {
                const value = await this._read(info, uuid);
                if (value) this.#info[key] = decoder.decode(value).replace(/\0+$/, '').trim();
            }
        }
        Object.freeze(this.#info);

        const battery = await this._getService(server, SERVICE.BATTERY);
        const level = battery && await this._getCharacteristic(battery, CHARACTERISTIC.BATTERY_LEVEL);
        if (level) {
            try {
                this.#batteryLevel = (await level.readValue()).getUint8(0);
            } catch { /* not readable */ }
            await this._subscribe(level, (view) => {
                this.#batteryLevel = view.getUint8(0);
                this._emit('battery', { level: this.#batteryLevel });
            }, { optional: true });
        }
    }

    // --- Protected helpers for subclasses -----------------------------------------------------

    /** Override: discover services and subscribe. Throw to abort the connection. */
    async _onConnected(server) { } // eslint-disable-line no-unused-vars

    /** Override: reset live values after a disconnect. */
    _onDisconnected() { }

    /** @protected @returns {Promise<BluetoothRemoteGATTService|null>} */
    async _getService(server, uuid) {
        try {
            return await server.getPrimaryService(uuid);
        } catch {
            return null;
        }
    }

    /** @protected @returns {Promise<BluetoothRemoteGATTCharacteristic|null>} */
    async _getCharacteristic(service, uuid) {
        try {
            return await service.getCharacteristic(uuid);
        } catch {
            return null;
        }
    }

    /** @protected Reads an optional characteristic; null when missing or unreadable. */
    async _read(service, uuid) {
        const characteristic = await this._getCharacteristic(service, uuid);
        if (!characteristic) return null;
        try {
            return await characteristic.readValue();
        } catch {
            return null;
        }
    }

    /**
     * @protected Subscribe to notifications/indications. Errors thrown by the handler are emitted
     * as 'error' events instead of breaking the notification stream.
     */
    async _subscribe(characteristic, handler, { optional = false } = {}) {
        const listener = (event) => {
            try {
                handler(event.target.value);
            } catch (error) {
                this._emit('error', error);
            }
        };
        characteristic.addEventListener('characteristicvaluechanged', listener);
        this.#cleanups.push(() => characteristic.removeEventListener('characteristicvaluechanged', listener));
        try {
            await characteristic.startNotifications();
        } catch (error) {
            if (!optional) throw error;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Bike / trainer
// ---------------------------------------------------------------------------------------------

const SOURCE_PRIORITY = Object.freeze({ ftms: 3, cyclingPower: 2, cyclingSpeedCadence: 1 });

function emptyBikeCapabilities() {
    return {
        protocols: { ftms: false, cyclingPower: false, cyclingSpeedCadence: false, simulated: false },
        data: {
            power: false, cadence: false, speed: false, distance: false, energy: false,
            resistance: false, heartRate: false, pedalPowerBalance: false, torque: false,
        },
        control: {
            resistance: false, targetPower: false, simulation: false, inclination: false,
            targetSpeed: false, wheelCircumference: false, startStop: false,
        },
        ranges: { resistance: null, power: null, inclination: null, speed: null },
        features: { ftms: null, cyclingPower: null, cyclingSpeedCadence: null },
    };
}

/**
 * Shared control/data API for real and simulated bikes. Documented on {@link BluetoothBike}.
 * @typedef {object} BikeData
 * @property {number|null} timestamp  ms since epoch of the notification
 * @property {number|null} power      W
 * @property {number|null} cadence    rpm
 * @property {number|null} speed      km/h
 * @property {number}      distance   m since connecting
 * @property {number}      energy     kJ of mechanical work since connecting
 * @property {number|null} resistance resistance level as reported by the trainer
 * @property {number|null} heartRate  bpm, when the trainer forwards a heart-rate strap
 */

/**
 * A smart trainer, spin bike, power meter or speed/cadence sensor.
 *
 * The bike subscribes to every supported profile it finds (FTMS, Cycling Power, CSC) and fuses the
 * values: per metric the best source wins (FTMS > Cycling Power > CSC) while it keeps updating.
 *
 * Extra events: 'control' (target changed), 'status' (FTMS machine status), 'battery'.
 */
export class BluetoothBike extends BleDevice {
    #capabilities = deepFreeze(emptyBikeCapabilities());
    #available = {};
    #metrics = BluetoothBike.#emptyMetrics();
    #distance = 0;
    #energy = 0; // J
    #ftmsDistanceRef = null;
    #lastSourceUpdate = {};
    #packets = {};
    #counters = {
        cyclingPower: { wheel: null, crank: null },
        cyclingSpeedCadence: { wheel: null, crank: null },
    };

    #controlPoint = null;
    #hasControl = false;
    #pendingCommand = null;
    #commandQueue = Promise.resolve();
    #target = { mode: null };
    #simulation = { windSpeed: 0, grade: 0, crr: 0.004, windResistance: 0.51 };

    /**
     * @param {object} [options]
     * @param {number} [options.wheelCircumference=2.105] m, used to turn wheel revolutions into speed/distance
     * @param {number} [options.staleTimeout=3000] ms without updates before power/cadence/speed read as 0
     * @param {'sint16'|'uint8'} [options.resistanceFormat='sint16'] FTMS "set target resistance" encoding
     * @param {number} [options.commandTimeout=3000] ms to wait for a control point response
     * @param {boolean} [options.autoReconnect=true]
     * @param {number} [options.reconnectAttempts=5]
     */
    constructor(options = {}) {
        super({
            wheelCircumference: 2.105,
            staleTimeout: 3000,
            resistanceFormat: 'sint16',
            commandTimeout: 3000,
            ...options,
        });
        this.#createCounters();
    }

    static requestOptions() {
        return {
            filters: [
                { services: [SERVICE.FITNESS_MACHINE] },
                { services: [SERVICE.CYCLING_POWER] },
                { services: [SERVICE.CYCLING_SPEED_AND_CADENCE] },
            ],
            optionalServices: [
                SERVICE.FITNESS_MACHINE, SERVICE.CYCLING_POWER, SERVICE.CYCLING_SPEED_AND_CADENCE,
                SERVICE.BATTERY, SERVICE.DEVICE_INFORMATION,
            ],
        };
    }

    static #emptyMetrics() {
        const metric = () => ({ value: null, source: null, time: 0 });
        return { power: metric(), cadence: metric(), speed: metric(), resistance: metric(), heartRate: metric() };
    }

    // --- Data -----------------------------------------------------------------------------------

    get power() { return this.#current('power'); }
    get cadence() { return this.#current('cadence'); }
    get speed() { return this.#current('speed'); }
    get resistance() { return this.#current('resistance'); }
    get heartRate() { return this.#current('heartRate'); }
    /** Distance in m since connecting. */
    get distance() { return this.#distance; }
    /** Mechanical work in kJ since connecting (integrated from power). */
    get energy() { return this.#energy / 1000; }

    /** @returns {BikeData} immutable snapshot of the latest values */
    get data() {
        return Object.freeze({
            timestamp: this.timestamp,
            power: this.power,
            cadence: this.cadence,
            speed: this.speed,
            distance: this.#distance,
            energy: this.#energy / 1000,
            resistance: this.resistance,
            heartRate: this.heartRate,
        });
    }

    /**
     * What the bike says it supports (read from its feature characteristics after connecting).
     * `{protocols, data, control, ranges, features}` – see README.
     */
    get capabilities() { return this.#capabilities; }

    /** Metrics actually observed in received data so far, e.g. `{power: true, cadence: true}`. */
    get available() { return { ...this.#available }; }

    /** The last raw parsed packet per profile: `{ftms, cyclingPower, cyclingSpeedCadence}`. */
    get rawData() { return { ...this.#packets }; }

    /** The last target sent to the trainer, e.g. `{mode: 'power', power: 200}`. */
    get target() { return { ...this.#target }; }

    get wheelCircumference() { return this.options.wheelCircumference; }

    // --- Control (FTMS) -------------------------------------------------------------------------

    /**
     * Set the resistance level (in the trainer's own units, see `capabilities.ranges.resistance`).
     * @returns {Promise<number>} the level actually sent (clamped to the supported range)
     */
    async setResistance(level) {
        this.#requireControl('resistance');
        const range = this.#capabilities.ranges.resistance;
        const value = range ? clamp(level, range.min, range.max) : level;
        const raw = Math.round(value * 10); // resolution 0.1
        const payload = this.options.resistanceFormat === 'uint8' ? uint8(raw) : int16(raw);
        await this.#command(FTMS_OPCODE.SET_TARGET_RESISTANCE_LEVEL, payload);
        this.#setTarget({ mode: 'resistance', resistance: value });
        return value;
    }

    /** Set the resistance as 0 – 100 % of the supported range (0 – 100 when the range is unknown). */
    async setResistancePercent(percent) {
        const range = this.#capabilities.ranges.resistance ?? { min: 0, max: 100 };
        return this.setResistance(range.min + (range.max - range.min) * clamp(percent, 0, 100) / 100);
    }

    /** ERG mode: hold the given power in watts regardless of cadence. */
    async setTargetPower(watts) {
        this.#requireControl('targetPower');
        const range = this.#capabilities.ranges.power;
        const value = range ? clamp(watts, range.min, range.max) : watts;
        await this.#command(FTMS_OPCODE.SET_TARGET_POWER, int16(value));
        this.#setTarget({ mode: 'power', power: value });
        return value;
    }

    /**
     * Simulation mode: the trainer computes resistance from virtual terrain.
     * Unspecified parameters keep their previous values.
     * @param {{grade?: number, windSpeed?: number, crr?: number, windResistance?: number}} params
     *   grade %, windSpeed m/s (headwind positive), crr rolling resistance coefficient,
     *   windResistance (CdA·ρ/2) kg/m
     */
    async setSimulation(params = {}) {
        this.#requireControl('simulation');
        const sim = { ...this.#simulation, ...params };
        const payload = [
            ...int16(sim.windSpeed * 1000), // 0.001 m/s
            ...int16(sim.grade * 100), // 0.01 %
            ...uint8(sim.crr * 10000), // 0.0001
            ...uint8(sim.windResistance * 100), // 0.01 kg/m
        ];
        await this.#command(FTMS_OPCODE.SET_INDOOR_BIKE_SIMULATION, payload);
        this.#simulation = sim;
        this.#setTarget({ mode: 'simulation', ...sim });
        return { ...sim };
    }

    /** Shortcut for `setSimulation({grade})`: the virtual road gradient in %. */
    async setGrade(grade) {
        return this.setSimulation({ grade });
    }

    /** Set the target inclination in % (for trainers that physically tilt). */
    async setTargetInclination(percent) {
        this.#requireControl('inclination');
        const range = this.#capabilities.ranges.inclination;
        const value = range ? clamp(percent, range.min, range.max) : percent;
        await this.#command(FTMS_OPCODE.SET_TARGET_INCLINATION, int16(value * 10));
        this.#setTarget({ mode: 'inclination', inclination: value });
        return value;
    }

    /** Set the target speed in km/h. */
    async setTargetSpeed(kmh) {
        this.#requireControl('targetSpeed');
        const range = this.#capabilities.ranges.speed;
        const value = range ? clamp(kmh, range.min, range.max) : kmh;
        await this.#command(FTMS_OPCODE.SET_TARGET_SPEED, uint16(value * 100));
        this.#setTarget({ mode: 'speed', speed: value });
        return value;
    }

    /**
     * Set the wheel circumference in metres. Always updates the local speed/distance calculation
     * and also informs the trainer when it supports it.
     */
    async setWheelCircumference(meters) {
        this.options.wheelCircumference = meters;
        if (this.isConnected && this.#capabilities.control.wheelCircumference) {
            await this.#command(FTMS_OPCODE.SET_WHEEL_CIRCUMFERENCE, uint16(meters * 10000)); // 0.1 mm
        }
        return meters;
    }

    async startTraining() {
        this.#requireControl('startStop');
        await this.#command(FTMS_OPCODE.START_OR_RESUME);
    }

    async stopTraining() {
        this.#requireControl('startStop');
        await this.#command(FTMS_OPCODE.STOP_OR_PAUSE, [0x01]);
    }

    async pauseTraining() {
        this.#requireControl('startStop');
        await this.#command(FTMS_OPCODE.STOP_OR_PAUSE, [0x02]);
    }

    /** Reset the trainer's targets and counters (FTMS Reset). */
    async resetTrainer() {
        this.#requireControl('startStop');
        await this.#command(FTMS_OPCODE.RESET);
        this.#hasControl = false; // Reset releases control on most trainers
        this.#setTarget({ mode: null });
    }

    /**
     * Send a raw Fitness Machine Control Point command (advanced). Control is requested
     * automatically. Resolves when the trainer answers "success", rejects with BleControlError.
     * @param {number} opCode
     * @param {number[]} [payload] parameter bytes
     */
    async sendControlCommand(opCode, payload = []) {
        if (!this.#controlPoint) throw new BleControlError('This bike has no Fitness Machine Control Point', { opCode });
        return this.#command(opCode, payload);
    }

    #requireControl(feature) {
        if (!this.isConnected) throw new BleControlError('The bike is not connected');
        if (!this.#capabilities.control[feature]) {
            throw new BleControlError(`This bike does not support '${feature}' control`);
        }
    }

    #setTarget(target) {
        this.#target = target;
        this._emit('control', { ...target });
    }

    /** Serialises commands: GATT allows only one outstanding operation per characteristic. */
    #command(opCode, payload = []) {
        const run = () => this.#sendCommand(opCode, payload, true);
        const result = this.#commandQueue.then(run, run);
        this.#commandQueue = result.catch(() => { });
        return result;
    }

    async #sendCommand(opCode, payload, retryOnPermission) {
        if (!this.#controlPoint) throw new BleControlError('The bike is not connected', { opCode });
        if (!this.#hasControl && opCode !== FTMS_OPCODE.REQUEST_CONTROL) {
            await this.#writeCommand(FTMS_OPCODE.REQUEST_CONTROL, []);
            this.#hasControl = true;
        }
        try {
            return await this.#writeCommand(opCode, payload);
        } catch (error) {
            const permissionLost = error instanceof BleControlError && error.resultCode === 0x05;
            if (permissionLost && retryOnPermission && opCode !== FTMS_OPCODE.REQUEST_CONTROL) {
                this.#hasControl = false;
                return this.#sendCommand(opCode, payload, false);
            }
            throw error;
        }
    }

    #writeCommand(opCode, payload) {
        const controlPoint = this.#controlPoint;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pendingCommand = null;
                reject(new BleControlError(`No response from the trainer to op code 0x${opCode.toString(16)}`, { opCode }));
            }, this.options.commandTimeout);
            this.#pendingCommand = {
                opCode,
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            };
            const bytes = Uint8Array.from([opCode, ...payload]);
            const write = controlPoint.writeValueWithResponse
                ? controlPoint.writeValueWithResponse(bytes)
                : controlPoint.writeValue(bytes);
            Promise.resolve(write).catch((error) => {
                const pending = this.#pendingCommand;
                this.#pendingCommand = null;
                pending?.reject(error);
            });
        });
    }

    #onControlPointResponse(view) {
        if (view.byteLength < 3 || view.getUint8(0) !== FTMS_OPCODE.RESPONSE_CODE) return;
        const opCode = view.getUint8(1);
        const resultCode = view.getUint8(2);
        const pending = this.#pendingCommand;
        if (!pending || pending.opCode !== opCode) return;
        this.#pendingCommand = null;
        if (resultCode === 0x01) {
            pending.resolve({ opCode, result: 'success' });
        } else {
            const result = FTMS_RESULT[resultCode] ?? `unknown result 0x${resultCode.toString(16)}`;
            pending.reject(new BleControlError(`Trainer rejected op code 0x${opCode.toString(16)}: ${result}`, { opCode, resultCode }));
        }
    }

    #onMachineStatus(view) {
        const opCode = view.getUint8(0);
        if (opCode === 0xFF) this.#hasControl = false;
        const parameters = Array.from(new Uint8Array(view.buffer, view.byteOffset + 1, view.byteLength - 1));
        this._emit('status', { opCode, status: FTMS_STATUS[opCode] ?? 'unknown', parameters });
    }

    // --- Connection -----------------------------------------------------------------------------

    async _onConnected(server) {
        this.#resetLiveValues();
        const caps = emptyBikeCapabilities();

        const ftms = await this._getService(server, SERVICE.FITNESS_MACHINE);
        const cps = await this._getService(server, SERVICE.CYCLING_POWER);
        const csc = await this._getService(server, SERVICE.CYCLING_SPEED_AND_CADENCE);
        if (!ftms && !cps && !csc) {
            throw new Error('The selected device exposes no Fitness Machine, Cycling Power or Speed & Cadence service');
        }

        if (ftms) await this.#setupFtms(ftms, caps);
        if (cps) await this.#setupCyclingPower(cps, caps);
        if (csc) await this.#setupCsc(csc, caps);

        caps.data.distance = caps.data.speed;
        caps.data.energy = caps.data.power;
        this.#capabilities = deepFreeze(caps);
    }

    _onDisconnected() {
        this.#controlPoint = null;
        this.#hasControl = false;
        if (this.#pendingCommand) {
            this.#pendingCommand.reject(new BleControlError('The bike disconnected', { opCode: this.#pendingCommand.opCode }));
            this.#pendingCommand = null;
        }
        this.#resetLiveValues();
    }

    async #setupFtms(service, caps) {
        const bikeData = await this._getCharacteristic(service, CHARACTERISTIC.INDOOR_BIKE_DATA);
        if (!bikeData) return; // A treadmill/rower etc. – not a bike.
        caps.protocols.ftms = true;

        const featureView = await this._read(service, CHARACTERISTIC.FITNESS_MACHINE_FEATURE);
        const features = featureView ? parseFitnessMachineFeature(featureView) : null;
        caps.features.ftms = features;
        const machine = features?.machine;
        caps.data.power ||= machine ? machine.powerMeasurement : true;
        caps.data.cadence ||= machine ? machine.cadence : true;
        caps.data.speed = true; // instantaneous speed is mandatory in Indoor Bike Data
        caps.data.resistance = machine ? machine.resistanceLevel : false;
        caps.data.heartRate = machine ? machine.heartRateMeasurement : false;

        const ranges = [
            ['speed', CHARACTERISTIC.SUPPORTED_SPEED_RANGE, { signed: false, divisor: 100 }],
            ['inclination', CHARACTERISTIC.SUPPORTED_INCLINATION_RANGE, { signed: true, divisor: 10 }],
            ['resistance', CHARACTERISTIC.SUPPORTED_RESISTANCE_LEVEL_RANGE, { signed: true, divisor: 10 }],
            ['power', CHARACTERISTIC.SUPPORTED_POWER_RANGE, { signed: true, divisor: 1 }],
        ];
        for (const [name, uuid, format] of ranges) {
            const view = await this._read(service, uuid);
            const range = view && parseSupportedRange(view, format);
            if (range && !range.truncated) caps.ranges[name] = range;
        }

        await this._subscribe(bikeData, (view) => this.#onIndoorBikeData(view));

        const controlPoint = await this._getCharacteristic(service, CHARACTERISTIC.FITNESS_MACHINE_CONTROL_POINT);
        if (controlPoint) {
            await this._subscribe(controlPoint, (view) => this.#onControlPointResponse(view));
            this.#controlPoint = controlPoint;
            const target = features?.target;
            const supports = (bit) => (target ? target[bit] : true); // unknown features: let the trainer decide
            caps.control.resistance = supports('resistanceTarget');
            caps.control.targetPower = supports('powerTarget');
            caps.control.simulation = supports('indoorBikeSimulation');
            caps.control.inclination = supports('inclinationTarget');
            caps.control.targetSpeed = supports('speedTarget');
            caps.control.wheelCircumference = supports('wheelCircumference');
            caps.control.startStop = true;
        }

        const status = await this._getCharacteristic(service, CHARACTERISTIC.FITNESS_MACHINE_STATUS);
        if (status) await this._subscribe(status, (view) => this.#onMachineStatus(view), { optional: true });
    }

    async #setupCyclingPower(service, caps) {
        const measurement = await this._getCharacteristic(service, CHARACTERISTIC.CYCLING_POWER_MEASUREMENT);
        if (!measurement) return;
        caps.protocols.cyclingPower = true;
        const view = await this._read(service, CHARACTERISTIC.CYCLING_POWER_FEATURE);
        const features = view ? parseCyclingPowerFeature(view) : null;
        caps.features.cyclingPower = features;
        caps.data.power = true;
        caps.data.cadence ||= features ? features.crankRevolutionData : false;
        caps.data.speed ||= features ? features.wheelRevolutionData : false;
        caps.data.pedalPowerBalance = features ? features.pedalPowerBalance : false;
        caps.data.torque = features ? features.accumulatedTorque : false;
        await this._subscribe(measurement, (v) => this.#onCyclingPowerMeasurement(v));
    }

    async #setupCsc(service, caps) {
        const measurement = await this._getCharacteristic(service, CHARACTERISTIC.CSC_MEASUREMENT);
        if (!measurement) return;
        caps.protocols.cyclingSpeedCadence = true;
        const view = await this._read(service, CHARACTERISTIC.CSC_FEATURE);
        const features = view ? parseCscFeature(view) : null;
        caps.features.cyclingSpeedCadence = features;
        caps.data.cadence ||= features ? features.crankRevolutionData : true;
        caps.data.speed ||= features ? features.wheelRevolutionData : true;
        await this._subscribe(measurement, (v) => this.#onCscMeasurement(v));
    }

    // --- Notification handlers ------------------------------------------------------------------

    #onIndoorBikeData(view) {
        const now = Date.now();
        const packet = parseIndoorBikeData(view);
        this.#packets.ftms = packet;
        if ('speed' in packet) this.#set('speed', packet.speed, 'ftms', now);
        if ('cadence' in packet) this.#set('cadence', packet.cadence, 'ftms', now);
        if ('power' in packet) this.#set('power', packet.power, 'ftms', now);
        if ('resistanceLevel' in packet) this.#set('resistance', packet.resistanceLevel, 'ftms', now);
        if (packet.heartRate > 0) this.#set('heartRate', packet.heartRate, 'ftms', now);

        let distanceDelta = null;
        if ('totalDistance' in packet) {
            const previous = this.#ftmsDistanceRef;
            this.#ftmsDistanceRef = packet.totalDistance;
            const delta = previous == null ? 0 : packet.totalDistance - previous;
            distanceDelta = delta >= 0 && delta < 1000 ? delta : 0;
        }
        this.#commit(now, 'ftms', distanceDelta);
    }

    #onCyclingPowerMeasurement(view) {
        const now = Date.now();
        const packet = parseCyclingPowerMeasurement(view);
        this.#packets.cyclingPower = packet;
        if ('power' in packet) this.#set('power', packet.power, 'cyclingPower', now);
        const distanceDelta = this.#handleRevolutions(packet, 'cyclingPower', now);
        this.#commit(now, 'cyclingPower', distanceDelta);
    }

    #onCscMeasurement(view) {
        const now = Date.now();
        const packet = parseCscMeasurement(view);
        this.#packets.cyclingSpeedCadence = packet;
        const distanceDelta = this.#handleRevolutions(packet, 'cyclingSpeedCadence', now);
        this.#commit(now, 'cyclingSpeedCadence', distanceDelta);
    }

    /** @returns {number|null} distance travelled in m according to the wheel counter */
    #handleRevolutions(packet, source, now) {
        const counters = this.#counters[source];
        if ('lastCrankEventTime' in packet) {
            const { rate } = counters.crank.update(packet.crankRevolutions, packet.lastCrankEventTime, now);
            if (rate != null) this.#set('cadence', rate * 60, source, now);
        }
        if ('lastWheelEventTime' in packet) {
            const { rate, revolutions } = counters.wheel.update(packet.wheelRevolutions, packet.lastWheelEventTime, now);
            if (rate != null) this.#set('speed', rate * this.options.wheelCircumference * 3.6, source, now);
            return revolutions * this.options.wheelCircumference;
        }
        return null;
    }

    /** Store a metric unless a higher-priority source is actively providing it. */
    #set(name, value, source, now) {
        const metric = this.#metrics[name];
        const fresh = now - metric.time <= this.options.staleTimeout;
        if (metric.source && SOURCE_PRIORITY[source] < SOURCE_PRIORITY[metric.source] && fresh) return;
        if (name === 'power' && metric.value != null && fresh) {
            this.#energy += Math.max(0, metric.value) * (now - metric.time) / 1000;
        }
        metric.value = value;
        metric.source = source;
        metric.time = now;
        this.#available[name] = true;
        if (name === 'power') this.#available.energy = true;
    }

    #commit(now, source, distanceDelta) {
        const speed = this.#metrics.speed;
        if (speed.source === source) {
            if (distanceDelta != null) {
                this.#distance += distanceDelta;
            } else if (speed.value != null) {
                const previous = this.#lastSourceUpdate[source];
                if (previous && now - previous <= this.options.staleTimeout) {
                    this.#distance += speed.value / 3.6 * (now - previous) / 1000;
                }
            }
            this.#available.distance = true;
        }
        this.#lastSourceUpdate[source] = now;
        this._touch(now);
        this._emit('data', this.data);
    }

    #current(name) {
        const metric = this.#metrics[name];
        if (metric.value == null) return null;
        if (name !== 'resistance' && Date.now() - metric.time > this.options.staleTimeout) {
            return name === 'heartRate' ? null : 0;
        }
        return metric.value;
    }

    #createCounters() {
        const staleTimeout = this.options.staleTimeout;
        this.#counters.cyclingPower.wheel = new RevolutionCounter({ revolutionBits: 32, ticksPerSecond: 2048, staleTimeout });
        this.#counters.cyclingPower.crank = new RevolutionCounter({ revolutionBits: 16, ticksPerSecond: 1024, staleTimeout });
        this.#counters.cyclingSpeedCadence.wheel = new RevolutionCounter({ revolutionBits: 32, ticksPerSecond: 1024, staleTimeout });
        this.#counters.cyclingSpeedCadence.crank = new RevolutionCounter({ revolutionBits: 16, ticksPerSecond: 1024, staleTimeout });
    }

    #resetLiveValues() {
        this.#metrics = BluetoothBike.#emptyMetrics();
        this.#available = {};
        this.#packets = {};
        this.#distance = 0;
        this.#energy = 0;
        this.#ftmsDistanceRef = null;
        this.#lastSourceUpdate = {};
        this.#createCounters();
    }
}

// ---------------------------------------------------------------------------------------------
// Heart-rate monitor
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} HeartRateData
 * @property {number|null}  timestamp       ms since epoch of the notification
 * @property {number|null}  heartRate       bpm
 * @property {number[]}     rrIntervals     RR intervals in ms contained in the latest notification
 * @property {number|null}  energyExpended  kJ, as reported by the strap
 * @property {boolean|null} contactDetected null when the strap does not report skin contact
 */

/** A Bluetooth heart-rate strap/watch (Heart Rate Service). */
export class HeartRateMonitor extends BleDevice {
    #heartRate = null;
    #rrIntervals = [];
    #energyExpended = null;
    #contactDetected = null;
    #capabilities = deepFreeze({ bodySensorLocation: null, rrIntervals: false, energyExpended: false, contactDetection: false });

    /**
     * @param {object} [options]
     * @param {number} [options.staleTimeout=5000] ms without notifications before heartRate reads null
     * @param {boolean} [options.autoReconnect=true]
     * @param {number} [options.reconnectAttempts=5]
     */
    constructor(options = {}) {
        super({ staleTimeout: 5000, ...options });
    }

    static requestOptions() {
        return {
            filters: [{ services: [SERVICE.HEART_RATE] }],
            optionalServices: [SERVICE.BATTERY, SERVICE.DEVICE_INFORMATION],
        };
    }

    get heartRate() {
        if (this.#heartRate == null || this.timestamp == null) return null;
        return Date.now() - this.timestamp > this.options.staleTimeout ? null : this.#heartRate;
    }
    get rrIntervals() { return [...this.#rrIntervals]; }
    get energyExpended() { return this.#energyExpended; }
    get contactDetected() { return this.#contactDetected; }

    /** `{bodySensorLocation, rrIntervals, energyExpended, contactDetection}`; the last three fill in as data arrives. */
    get capabilities() { return this.#capabilities; }

    /** @returns {HeartRateData} */
    get data() {
        return Object.freeze({
            timestamp: this.timestamp,
            heartRate: this.heartRate,
            rrIntervals: Object.freeze([...this.#rrIntervals]),
            energyExpended: this.#energyExpended,
            contactDetected: this.#contactDetected,
        });
    }

    async _onConnected(server) {
        const service = await this._getService(server, SERVICE.HEART_RATE);
        const measurement = service && await this._getCharacteristic(service, CHARACTERISTIC.HEART_RATE_MEASUREMENT);
        if (!measurement) throw new Error('The selected device exposes no Heart Rate Measurement characteristic');
        const location = await this._read(service, CHARACTERISTIC.BODY_SENSOR_LOCATION);
        this.#capabilities = {
            bodySensorLocation: location ? (BODY_SENSOR_LOCATIONS[location.getUint8(0)] ?? 'other') : null,
            rrIntervals: false,
            energyExpended: false,
            contactDetection: false,
        };
        await this._subscribe(measurement, (view) => this.#onMeasurement(view));
    }

    _onDisconnected() {
        this.#heartRate = null;
        this.#rrIntervals = [];
        this.#energyExpended = null;
        this.#contactDetected = null;
    }

    #onMeasurement(view) {
        const packet = parseHeartRateMeasurement(view);
        if (!('heartRate' in packet)) return;
        const caps = this.#capabilities;
        if (Object.isFrozen(caps)) this.#capabilities = { ...caps };
        if (packet.rrIntervals?.length) this.#capabilities.rrIntervals = true;
        if ('energyExpended' in packet) this.#capabilities.energyExpended = true;
        if (packet.contactDetected != null) this.#capabilities.contactDetection = true;

        this.#heartRate = packet.heartRate > 0 && packet.contactDetected !== false ? packet.heartRate : null;
        this.#rrIntervals = packet.rrIntervals ?? [];
        if ('energyExpended' in packet) this.#energyExpended = packet.energyExpended;
        this.#contactDetected = packet.contactDetected;
        this._touch();
        this._emit('data', this.data);
    }
}

// ---------------------------------------------------------------------------------------------
// Simulators – same API as the real devices, for development without hardware
// ---------------------------------------------------------------------------------------------

const noise = (amplitude) => (Math.random() * 2 - 1) * amplitude;

/** Steady-state speed (m/s) for a given power on a given grade, solved by bisection. */
function speedFromPower(power, grade, mass) {
    if (power <= 0) return 0;
    const slope = Math.atan(grade / 100);
    const resistive = mass * 9.81 * (0.004 * Math.cos(slope) + Math.sin(slope));
    const drag = 0.5 * 1.225 * 0.32;
    let low = 0, high = 40;
    for (let i = 0; i < 40; i++) {
        const v = (low + high) / 2;
        if (v * resistive + drag * v ** 3 > power) high = v; else low = v;
    }
    return (low + high) / 2;
}

/**
 * A fake trainer that produces realistic-looking data and obeys the control commands.
 * Use it exactly like {@link BluetoothBike}. Set `pedaling = false` to simulate stopping and
 * `targetCadence` to change the virtual rider's cadence.
 */
export class SimulatedBike extends DeviceBase {
    #timer = null;
    #lastTick = null;
    #power = null;
    #cadence = null;
    #speed = null;
    #distance = 0;
    #energy = 0;
    #target = { mode: null };
    #simulation = { windSpeed: 0, grade: 0, crr: 0.004, windResistance: 0.51 };

    /**
     * @param {object} [options]
     * @param {number} [options.interval=1000] ms between data notifications
     * @param {number} [options.riderMass=80] kg (rider + bike), used for the speed model
     * @param {string} [options.name='Simulated Bike']
     */
    constructor(options = {}) {
        super();
        this.options = { interval: 1000, riderMass: 80, name: 'Simulated Bike', wheelCircumference: 2.105, ...options };
        this.pedaling = true;
        this.targetCadence = 85;
    }

    get name() { return this.options.name; }
    get id() { return 'simulated-bike'; }
    get info() { return { manufacturer: 'Simulator', model: 'SimulatedBike' }; }
    get batteryLevel() { return null; }
    get power() { return this.isConnected ? this.#power : null; }
    get cadence() { return this.isConnected ? this.#cadence : null; }
    get speed() { return this.isConnected ? this.#speed : null; }
    get resistance() { return this.#target.mode === 'resistance' ? this.#target.resistance : null; }
    get heartRate() { return null; }
    get distance() { return this.#distance; }
    get energy() { return this.#energy / 1000; }
    get target() { return { ...this.#target }; }
    get wheelCircumference() { return this.options.wheelCircumference; }
    get rawData() { return {}; }

    get data() {
        return Object.freeze({
            timestamp: this.timestamp,
            power: this.power,
            cadence: this.cadence,
            speed: this.speed,
            distance: this.#distance,
            energy: this.#energy / 1000,
            resistance: this.resistance,
            heartRate: null,
        });
    }

    get capabilities() {
        const caps = emptyBikeCapabilities();
        caps.protocols.simulated = true;
        Object.assign(caps.data, { power: true, cadence: true, speed: true, distance: true, energy: true, resistance: true });
        Object.keys(caps.control).forEach((key) => { caps.control[key] = true; });
        caps.ranges.resistance = { min: 0, max: 100, increment: 1 };
        caps.ranges.power = { min: 0, max: 2000, increment: 1 };
        caps.ranges.inclination = { min: -20, max: 20, increment: 0.1 };
        return deepFreeze(caps);
    }

    get available() {
        return this.timestamp ? { power: true, cadence: true, speed: true, distance: true, energy: true } : {};
    }

    async connect() {
        if (this.isConnected) return this;
        this._setState(CONNECTION_STATE.CONNECTING);
        await new Promise((resolve) => setTimeout(resolve, 300));
        this.#lastTick = null;
        this.#timer = setInterval(() => this.#tick(), this.options.interval);
        this._setState(CONNECTION_STATE.CONNECTED);
        this._emit('connect', { name: this.name });
        return this;
    }

    async reconnect() {
        return this.connect();
    }

    disconnect() {
        if (this.state === CONNECTION_STATE.DISCONNECTED) return;
        clearInterval(this.#timer);
        this.#timer = null;
        this.#power = this.#cadence = this.#speed = null;
        this.#distance = this.#energy = 0;
        this._clearTimestamp();
        this._setState(CONNECTION_STATE.DISCONNECTED);
        this._emit('disconnect', { expected: true });
    }

    async setResistance(level) { return this.#control({ mode: 'resistance', resistance: clamp(level, 0, 100) }).resistance; }
    async setResistancePercent(percent) { return this.setResistance(percent); }
    async setTargetPower(watts) { return this.#control({ mode: 'power', power: clamp(watts, 0, 2000) }).power; }
    async setSimulation(params = {}) {
        this.#simulation = { ...this.#simulation, ...params };
        this.#control({ mode: 'simulation', ...this.#simulation });
        return { ...this.#simulation };
    }
    async setGrade(grade) { return this.setSimulation({ grade }); }
    async setTargetInclination(percent) { return this.#control({ mode: 'inclination', inclination: percent }).inclination; }
    async setTargetSpeed(kmh) { return this.#control({ mode: 'speed', speed: kmh }).speed; }
    async setWheelCircumference(meters) { this.options.wheelCircumference = meters; return meters; }
    async startTraining() { }
    async stopTraining() { }
    async pauseTraining() { }
    async resetTrainer() { this.#control({ mode: null }); }
    async sendControlCommand() { return { result: 'success' }; }

    #control(target) {
        if (!this.isConnected) throw new BleControlError('The bike is not connected');
        this.#target = target;
        this._emit('control', { ...target });
        return target;
    }

    #tick() {
        const now = Date.now();
        const dt = this.#lastTick ? (now - this.#lastTick) / 1000 : this.options.interval / 1000;
        this.#lastTick = now;

        const cadenceGoal = this.pedaling ? this.targetCadence : 0;
        const cadence = this.#cadence ?? 0;
        this.#cadence = Math.max(0, cadence + (cadenceGoal - cadence) * 0.4 + (this.pedaling ? noise(2) : 0));

        const grade = this.#target.mode === 'simulation' ? this.#target.grade
            : this.#target.mode === 'inclination' ? this.#target.inclination : 0;
        let power;
        switch (this.#target.mode) {
            case 'power':
                power = this.#cadence > 20 ? this.#target.power * (1 + noise(0.03)) : 0;
                break;
            case 'resistance':
                power = this.#cadence * (0.6 + this.#target.resistance / 40);
                break;
            default:
                power = this.#cadence * 2 * clamp(1 + grade * 0.08, 0.3, 2.5);
        }
        this.#power = Math.max(0, Math.round(power));

        const speed = speedFromPower(this.#power, grade, this.options.riderMass); // m/s
        this.#speed = speed * 3.6;
        this.#distance += speed * dt;
        this.#energy += this.#power * dt;
        this._touch(now);
        this._emit('data', this.data);
    }
}

/**
 * A fake heart-rate monitor. When given a bike, the heart rate follows the bike's power.
 */
export class SimulatedHeartRateMonitor extends DeviceBase {
    #timer = null;
    #heartRate = null;
    #rrIntervals = [];

    /**
     * @param {object} [options]
     * @param {DeviceBase} [options.bike] heart rate follows this bike's power when given
     * @param {number} [options.interval=1000]
     * @param {number} [options.restingHeartRate=60]
     * @param {number} [options.maxHeartRate=190]
     * @param {number} [options.ftp=250] W, power at which the heart rate approaches threshold
     */
    constructor(options = {}) {
        super();
        this.options = { interval: 1000, restingHeartRate: 60, maxHeartRate: 190, ftp: 250, name: 'Simulated HRM', ...options };
    }

    get name() { return this.options.name; }
    get id() { return 'simulated-hrm'; }
    get info() { return { manufacturer: 'Simulator', model: 'SimulatedHeartRateMonitor' }; }
    get batteryLevel() { return null; }
    get heartRate() { return this.isConnected ? this.#heartRate : null; }
    get rrIntervals() { return [...this.#rrIntervals]; }
    get energyExpended() { return null; }
    get contactDetected() { return this.isConnected ? true : null; }
    get capabilities() {
        return deepFreeze({ bodySensorLocation: 'chest', rrIntervals: true, energyExpended: false, contactDetection: true });
    }
    get data() {
        return Object.freeze({
            timestamp: this.timestamp,
            heartRate: this.heartRate,
            rrIntervals: Object.freeze([...this.#rrIntervals]),
            energyExpended: null,
            contactDetected: this.contactDetected,
        });
    }

    async connect() {
        if (this.isConnected) return this;
        this._setState(CONNECTION_STATE.CONNECTING);
        await new Promise((resolve) => setTimeout(resolve, 300));
        this.#heartRate = this.options.restingHeartRate + 10;
        this.#timer = setInterval(() => this.#tick(), this.options.interval);
        this._setState(CONNECTION_STATE.CONNECTED);
        this._emit('connect', { name: this.name });
        return this;
    }

    async reconnect() {
        return this.connect();
    }

    disconnect() {
        if (this.state === CONNECTION_STATE.DISCONNECTED) return;
        clearInterval(this.#timer);
        this.#timer = null;
        this.#heartRate = null;
        this._clearTimestamp();
        this._setState(CONNECTION_STATE.DISCONNECTED);
        this._emit('disconnect', { expected: true });
    }

    #tick() {
        const { restingHeartRate, maxHeartRate, ftp, bike } = this.options;
        const intensity = bike ? clamp((bike.power ?? 0) / ftp, 0, 1.3) : 0.4;
        const goal = restingHeartRate + (maxHeartRate - restingHeartRate) * intensity * 0.75;
        this.#heartRate = Math.round(this.#heartRate + (goal - this.#heartRate) * 0.08 + noise(1));
        this.#rrIntervals = [60000 / this.#heartRate];
        this._touch();
        this._emit('data', this.data);
    }
}
