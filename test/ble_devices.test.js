import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SERVICE, CHARACTERISTIC, FTMS_OPCODE, BleControlError, RevolutionCounter,
    BluetoothBike, HeartRateMonitor, SimulatedBike, SimulatedHeartRateMonitor,
    parseCyclingPowerMeasurement, parseIndoorBikeData, parseCscMeasurement, parseHeartRateMeasurement,
    parseFitnessMachineFeature, parseSupportedRange,
} from '../src/ble_devices.module.js';

// --- Fake Web Bluetooth GATT ------------------------------------------------------------------

const view = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeCharacteristic extends EventTarget {
    constructor(uuid, { value = null, onWrite = null } = {}) {
        super();
        this.uuid = uuid;
        this.value = value ? view(value) : null;
        this.onWrite = onWrite;
        this.written = [];
    }
    async readValue() {
        if (!this.value) throw new Error('not readable');
        return this.value;
    }
    async startNotifications() { return this; }
    async writeValueWithResponse(bytes) {
        this.written.push([...bytes]);
        this.onWrite?.([...bytes], this);
    }
    notify(bytes) {
        this.value = view(bytes);
        this.dispatchEvent(new Event('characteristicvaluechanged'));
    }
}

class FakeService {
    constructor(characteristics) { this.characteristics = characteristics; }
    async getCharacteristic(uuid) {
        const found = this.characteristics.find((c) => c.uuid === uuid);
        if (!found) throw new Error('NotFoundError');
        return found;
    }
}

class FakeDevice extends EventTarget {
    constructor(name, services) {
        super();
        this.name = name;
        this.id = name;
        const server = {
            getPrimaryService: async (uuid) => {
                if (!services[uuid]) throw new Error('NotFoundError');
                return services[uuid];
            },
        };
        this.gatt = {
            connected: false,
            connect: async () => { this.gatt.connected = true; return server; },
            disconnect: () => {
                this.gatt.connected = false;
                this.dispatchEvent(new Event('gattserverdisconnected'));
            },
        };
    }
}

/** An FTMS trainer that answers control point writes with the given result code. */
function fakeFtmsTrainer({ resultCode = 0x01 } = {}) {
    const controlPoint = new FakeCharacteristic(CHARACTERISTIC.FITNESS_MACHINE_CONTROL_POINT, {
        onWrite: (bytes, self) => setTimeout(() => self.notify([0x80, bytes[0], bytes[0] === 0 ? 0x01 : resultCode]), 1),
    });
    const bikeData = new FakeCharacteristic(CHARACTERISTIC.INDOOR_BIKE_DATA);
    // machine features: cadence(1) + resistanceLevel(7) + powerMeasurement(14); targets: resistance(2) + power(3) + simulation(13)
    const machine = (1 << 1) | (1 << 7) | (1 << 14);
    const target = (1 << 2) | (1 << 3) | (1 << 13);
    const feature = new FakeCharacteristic(CHARACTERISTIC.FITNESS_MACHINE_FEATURE, {
        value: [machine & 0xFF, (machine >> 8) & 0xFF, 0, 0, target & 0xFF, (target >> 8) & 0xFF, 0, 0],
    });
    const powerRange = new FakeCharacteristic(CHARACTERISTIC.SUPPORTED_POWER_RANGE, { value: [0, 0, 0xD0, 0x07, 1, 0] }); // 0–2000 W
    const ftms = new FakeService([controlPoint, bikeData, feature, powerRange]);
    const device = new FakeDevice('Fake KICKR', { [SERVICE.FITNESS_MACHINE]: ftms });
    return { device, controlPoint, bikeData };
}

// --- Parsers ----------------------------------------------------------------------------------

test('parseCyclingPowerMeasurement reads little-endian flags and revolution data', () => {
    const p = parseCyclingPowerMeasurement([
        0x30, 0x00, // flags: wheel (bit 4) + crank (bit 5)
        0xFA, 0x00, // 250 W
        100, 0, 0, 0, 0x00, 0x08, // 100 wheel revs, t = 2048/2048 s
        10, 0, 0x00, 0x04, // 10 crank revs, t = 1024/1024 s
    ]);
    assert.equal(p.power, 250);
    assert.equal(p.wheelRevolutions, 100);
    assert.equal(p.lastWheelEventTime, 2048);
    assert.equal(p.crankRevolutions, 10);
    assert.equal(p.lastCrankEventTime, 1024);
    assert.equal(p.truncated, undefined);
});

test('parseCyclingPowerMeasurement handles the high flag byte (accumulated energy)', () => {
    const p = parseCyclingPowerMeasurement([0x00, 0x08, 0x2C, 0x01, 5, 0]);
    assert.equal(p.power, 300);
    assert.equal(p.accumulatedEnergy, 5);
});

test('parseIndoorBikeData reads speed, cadence and power', () => {
    const p = parseIndoorBikeData([0x44, 0x00, 0xB8, 0x0B, 0xB4, 0x00, 0xC8, 0x00]);
    assert.equal(p.speed, 30);
    assert.equal(p.cadence, 90);
    assert.equal(p.power, 200);
    assert.equal(p.moreData, false);
});

test('parseIndoorBikeData: More Data bit means speed is absent', () => {
    const p = parseIndoorBikeData([0x41, 0x00, 0x64, 0x00]);
    assert.equal('speed' in p, false);
    assert.equal(p.power, 100);
});

test('parseCscMeasurement reads wheel and crank data', () => {
    const p = parseCscMeasurement([0x03, 1, 0, 0, 0, 0x00, 0x04, 2, 0, 0x00, 0x08]);
    assert.deepEqual([p.wheelRevolutions, p.lastWheelEventTime, p.crankRevolutions, p.lastCrankEventTime], [1, 1024, 2, 2048]);
});

test('parseHeartRateMeasurement supports uint8, uint16 and RR intervals', () => {
    const a = parseHeartRateMeasurement([0x10, 72, 0x00, 0x04, 0x00, 0x02]);
    assert.equal(a.heartRate, 72);
    assert.deepEqual(a.rrIntervals, [1000, 500]);
    const b = parseHeartRateMeasurement([0x01, 0x2C, 0x01]);
    assert.equal(b.heartRate, 300);
    const c = parseHeartRateMeasurement([0x06, 60]);
    assert.equal(c.contactDetected, true);
});

test('truncated packets keep parsed fields and flag truncation', () => {
    const p = parseCyclingPowerMeasurement([0x20, 0x00, 0x64, 0x00, 1]);
    assert.equal(p.power, 100);
    assert.equal(p.truncated, true);
});

test('feature and range parsers', () => {
    const f = parseFitnessMachineFeature([0x02, 0x40, 0, 0, 0x0C, 0x20, 0, 0]);
    assert.equal(f.machine.cadence, true);
    assert.equal(f.machine.powerMeasurement, true);
    assert.equal(f.target.powerTarget, true);
    assert.equal(f.target.indoorBikeSimulation, true);
    assert.equal(f.target.speedTarget, false);
    const r = parseSupportedRange([0xF6, 0xFF, 0xE8, 0x03, 0x0A, 0x00], { signed: true, divisor: 10 });
    assert.deepEqual(r, { min: -1, max: 100, increment: 1 });
});

test('RevolutionCounter handles roll-over and decays to zero when stopped', () => {
    const counter = new RevolutionCounter({ revolutionBits: 16, ticksPerSecond: 1024, staleTimeout: 3000 });
    assert.equal(counter.update(65535, 65000, 0).rate, null);
    const r = counter.update(1, (65000 + 1024) % 65536, 1000);
    assert.equal(r.rate, 2);
    assert.equal(r.revolutions, 2);
    assert.equal(counter.update(1, (65000 + 1024) % 65536, 2000).rate, 2); // duplicate packet keeps rate
    assert.equal(counter.update(1, (65000 + 1024) % 65536, 5000).rate, 0); // stale → 0
});

// --- BluetoothBike ------------------------------------------------------------------------------

test('BluetoothBike connects to an FTMS trainer and reports capabilities', async () => {
    const { device, bikeData } = fakeFtmsTrainer();
    const bike = new BluetoothBike({ autoReconnect: false });
    await bike.connect({ device });
    assert.equal(bike.isConnected, true);
    assert.equal(bike.name, 'Fake KICKR');
    assert.equal(bike.capabilities.protocols.ftms, true);
    assert.equal(bike.capabilities.data.power, true);
    assert.equal(bike.capabilities.control.targetPower, true);
    assert.equal(bike.capabilities.control.inclination, false);
    assert.deepEqual(bike.capabilities.ranges.power, { min: 0, max: 2000, increment: 1 });

    const received = [];
    bike.on('data', (data) => received.push(data));
    bikeData.notify([0x44, 0x00, 0xB8, 0x0B, 0xB4, 0x00, 0xC8, 0x00]);
    assert.equal(received.length, 1);
    assert.equal(received[0].power, 200);
    assert.equal(received[0].cadence, 90);
    assert.equal(received[0].speed, 30);
    assert.equal(bike.available.power, true);
    assert.equal(typeof received[0].timestamp, 'number');
    bike.disconnect();
});

test('BluetoothBike requests control, then sends ERG and simulation commands', async () => {
    const { device, controlPoint } = fakeFtmsTrainer();
    const bike = new BluetoothBike({ autoReconnect: false });
    await bike.connect({ device });
    assert.equal(await bike.setTargetPower(5000), 2000); // clamped to the supported range
    assert.deepEqual(controlPoint.written, [[FTMS_OPCODE.REQUEST_CONTROL], [FTMS_OPCODE.SET_TARGET_POWER, 0xD0, 0x07]]);
    await bike.setGrade(-2.5);
    assert.deepEqual(controlPoint.written[2], [FTMS_OPCODE.SET_INDOOR_BIKE_SIMULATION, 0, 0, 0x06, 0xFF, 40, 51]);
    assert.equal(bike.target.mode, 'simulation');
    await assert.rejects(bike.setTargetInclination(3), BleControlError);
    bike.disconnect();
});

test('BluetoothBike surfaces rejected commands as BleControlError', async () => {
    const { device } = fakeFtmsTrainer({ resultCode: 0x03 });
    const bike = new BluetoothBike({ autoReconnect: false });
    await bike.connect({ device });
    await assert.rejects(bike.setResistance(10), (error) => error instanceof BleControlError && error.result === 'invalid-parameter');
    bike.disconnect();
});

test('BluetoothBike reports unexpected disconnects', async () => {
    const { device } = fakeFtmsTrainer();
    const bike = new BluetoothBike({ autoReconnect: false });
    await bike.connect({ device });
    const events = [];
    bike.on('disconnect', (detail) => events.push(detail));
    device.gatt.disconnect();
    assert.deepEqual(events, [{ expected: false }]);
    assert.equal(bike.state, 'disconnected');
    assert.equal(bike.power, null);
});

test('BluetoothBike derives cadence, speed and distance from Cycling Power revolutions', async () => {
    const measurement = new FakeCharacteristic(CHARACTERISTIC.CYCLING_POWER_MEASUREMENT);
    const cps = new FakeService([measurement]);
    const device = new FakeDevice('Power meter', { [SERVICE.CYCLING_POWER]: cps });
    const bike = new BluetoothBike({ autoReconnect: false, wheelCircumference: 2 });
    await bike.connect({ device });
    assert.equal(bike.capabilities.protocols.cyclingPower, true);
    assert.equal(bike.capabilities.control.resistance, false);

    measurement.notify([0x30, 0x00, 0xC8, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await sleep(20);
    // +5 wheel revs in 1 s (2048 ticks) and +1.5 crank revs… use 2 revs in 1.5 s → 80 rpm
    measurement.notify([0x30, 0x00, 0xC8, 0x00, 5, 0, 0, 0, 0x00, 0x08, 2, 0, 0x00, 0x06]);
    assert.equal(bike.power, 200);
    assert.equal(bike.cadence, 80);
    assert.equal(bike.speed, 5 * 2 * 3.6);
    assert.equal(bike.distance, 10);
    assert.ok(bike.energy > 0);
    bike.disconnect();
});

test('HeartRateMonitor connects and reports heart rate and RR intervals', async () => {
    const measurement = new FakeCharacteristic(CHARACTERISTIC.HEART_RATE_MEASUREMENT);
    const location = new FakeCharacteristic(CHARACTERISTIC.BODY_SENSOR_LOCATION, { value: [1] });
    const device = new FakeDevice('Strap', { [SERVICE.HEART_RATE]: new FakeService([measurement, location]) });
    const hrm = new HeartRateMonitor({ autoReconnect: false });
    await hrm.connect({ device });
    assert.equal(hrm.capabilities.bodySensorLocation, 'chest');
    measurement.notify([0x10, 120, 0x00, 0x02]);
    assert.equal(hrm.heartRate, 120);
    assert.deepEqual(hrm.data.rrIntervals, [500]);
    assert.equal(hrm.capabilities.rrIntervals, true);
    hrm.disconnect();
    assert.equal(hrm.heartRate, null);
});

test('connect() rejects devices without a supported service', async () => {
    const device = new FakeDevice('Mouse', {});
    const bike = new BluetoothBike({ autoReconnect: false });
    await assert.rejects(bike.connect({ device }), /no Fitness Machine/);
    assert.equal(bike.state, 'disconnected');
});

// --- Simulators -------------------------------------------------------------------------------

test('SimulatedBike and SimulatedHeartRateMonitor produce data and obey ERG', async () => {
    const bike = new SimulatedBike({ interval: 10 });
    const hrm = new SimulatedHeartRateMonitor({ bike, interval: 10 });
    await Promise.all([bike.connect(), hrm.connect()]);
    await bike.setTargetPower(220);
    await sleep(80);
    assert.ok(Math.abs(bike.power - 220) < 15, `power ${bike.power}`);
    assert.ok(bike.speed > 20 && bike.speed < 50, `speed ${bike.speed}`);
    assert.ok(bike.distance > 0);
    assert.ok(hrm.heartRate > 50);
    bike.disconnect();
    hrm.disconnect();
    await tick();
});
