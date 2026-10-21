import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buttons, ZwiftClickerV2, ZwiftControllerGroup } from '../src/zwift_controller.module.js';

// --- Fake Web Bluetooth GATT ------------------------------------------------------------------

globalThis.BluetoothUUID ??= {
    getService: (alias) => `0000${alias.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`,
};

const ZWIFT_SERVICE = '0000fc82-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHAR = '00000002-19ca-4651-86e5-fa29dcdd09d1';
const SYNC_RX_CHAR = '00000003-19ca-4651-86e5-fa29dcdd09d1';
const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';
const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e];

class FakeCharacteristic extends EventTarget {
    constructor(uuid, properties, value = null) {
        super();
        this.uuid = uuid;
        this.properties = { notify: false, indicate: false, read: false, write: false, writeWithoutResponse: false, ...properties };
        this.value = value ? new DataView(Uint8Array.from(value).buffer) : null;
        this.written = [];
    }
    async startNotifications() { return this; }
    async readValue() { return this.value; }
    async writeValueWithResponse(bytes) { this.written.push([...bytes]); }
    async writeValueWithoutResponse(bytes) { this.written.push([...bytes]); }
    notify(bytes) {
        this.value = new DataView(Uint8Array.from(bytes).buffer);
        this.dispatchEvent(new Event('characteristicvaluechanged'));
    }
}

function fakeClicker(name = 'Zwift Click') {
    const notify = new FakeCharacteristic(NOTIFY_CHAR, { notify: true });
    const syncRx = new FakeCharacteristic(SYNC_RX_CHAR, { write: true });
    const battery = new FakeCharacteristic(BATTERY_CHAR, { read: true, notify: true }, [77]);
    const services = [
        { uuid: ZWIFT_SERVICE, getCharacteristics: async () => [notify, syncRx] },
        { uuid: BATTERY_SERVICE, getCharacteristics: async () => [battery] },
    ];
    const device = new EventTarget();
    Object.assign(device, {
        name,
        id: name,
        gatt: {
            connected: false,
            connect: async () => {
                device.gatt.connected = true;
                return { getPrimaryServices: async () => services };
            },
            disconnect: () => {
                device.gatt.connected = false;
                device.dispatchEvent(new Event('gattserverdisconnected'));
            },
        },
    });
    return { device, notify, syncRx, battery };
}

async function connectedClicker(name) {
    const fake = fakeClicker(name);
    const clicker = new ZwiftClickerV2(fake.device);
    await clicker.connect();
    return { clicker, ...fake };
}

const varint = (value) => {
    const bytes = [];
    let v = value >>> 0;
    while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
    bytes.push(v);
    return bytes;
};

/** Zwift Click v2 / Ride keypad message: type 0x23, field 1 = bitmap where a cleared bit means pressed. */
const IDLE = 0xffff;
const keypad = (...pressed) => {
    let map = IDLE;
    for (const button of pressed) map &= ~(1 << BITS.indexOf(button));
    return [0x23, 0x08, ...varint(map)];
};
const BITS = [
    Buttons.LEFT, Buttons.UP, Buttons.RIGHT, Buttons.DOWN, Buttons.A, Buttons.B, Buttons.Y, Buttons.Z,
    Buttons.SHIFT_UP_L, Buttons.SHIFT_DOWN_L, Buttons.POWERUP_L, Buttons.ONOFF_L,
    Buttons.SHIFT_UP_R, Buttons.SHIFT_DOWN_R, Buttons.POWERUP_R, Buttons.ONOFF_R,
];

// --- Tests ------------------------------------------------------------------------------------

test('connect() subscribes, reads the battery and sends the RideOn handshake', async () => {
    const fake = fakeClicker();
    const clicker = new ZwiftClickerV2(fake.device);
    const events = [];
    clicker.on('connected', () => events.push('connected'));
    await clicker.connect();
    assert.deepEqual(fake.syncRx.written, [RIDE_ON]);
    assert.equal(clicker.battery, 77);
    assert.equal(clicker.connected, true);
    assert.equal(clicker.name, 'Zwift Click');
    assert.deepEqual(events, ['connected']);
});

test('keypad bitmap: press and release with polling and events', async () => {
    const { clicker, notify } = await connectedClicker();
    const log = [];
    clicker.on('buttondown', (e) => log.push(`down ${e.detail.button}`));
    clicker.on('buttonup', (e) => log.push(`up ${e.detail.button}`));

    notify.notify(keypad());
    notify.notify(keypad(Buttons.A));
    assert.equal(clicker.isDown(Buttons.A), true);
    assert.deepEqual(clicker.buttonsDown, [Buttons.A]);
    assert.equal(clicker.justPressed(Buttons.A), false); // only visible after update()
    clicker.update();
    assert.equal(clicker.justPressed(Buttons.A), true);
    assert.equal(clicker.pressCount(Buttons.A), 1);

    notify.notify(keypad());
    clicker.update();
    assert.equal(clicker.isDown(Buttons.A), false);
    assert.equal(clicker.justPressed(Buttons.A), false);
    assert.equal(clicker.justReleased(Buttons.A), true);
    assert.deepEqual(log, ['down a', 'up a']);
});

test('fast double taps within one frame are all counted', async () => {
    const { clicker, notify } = await connectedClicker();
    for (let i = 0; i < 2; i++) {
        notify.notify(keypad(Buttons.SHIFT_UP_R));
        notify.notify(keypad());
    }
    clicker.update();
    assert.equal(clicker.pressCount(Buttons.SHIFT_UP_R), 2);
    assert.equal(clicker.isDown(Buttons.SHIFT_UP_R), false);
});

test('several buttons at once', async () => {
    const { clicker, notify } = await connectedClicker();
    notify.notify(keypad(Buttons.SHIFT_UP_L, Buttons.POWERUP_R));
    assert.deepEqual(new Set(clicker.buttonsDown), new Set([Buttons.SHIFT_UP_L, Buttons.POWERUP_R]));
});

test('Click v1 / Play messages: missing button fields count as released', async () => {
    const { clicker, notify } = await connectedClicker();
    notify.notify([0x37, 0x08, 0x01, 0x10, 0x00]); // field 1 released, field 2 (bit 1 = UP) pressed
    assert.deepEqual(clicker.buttonsDown, [Buttons.UP]);
    notify.notify([0x37, 0x08, 0x01, 0x10, 0x01]);
    assert.deepEqual(clicker.buttonsDown, []);
});

test('battery messages and handshake replies are recognised', async () => {
    const { clicker, notify } = await connectedClicker();
    const seen = [];
    clicker.on('battery', (e) => seen.push(e.detail.level));
    clicker.on('handshake', () => seen.push('handshake'));
    notify.notify([0x19, 0x08, 0x55]);
    notify.notify([...RIDE_ON, 0x02, 0x03]);
    assert.deepEqual(seen, [85, 'handshake']);
    assert.equal(clicker.battery, 85);
    assert.deepEqual(clicker.buttonsDown, []); // neither message touched the buttons
});

test('malformed messages are ignored', async () => {
    const { clicker, notify } = await connectedClicker();
    notify.notify([0x23, 0x08, 0xff]); // truncated varint
    notify.notify([0x23, 0x0f]); // unsupported wire type
    assert.deepEqual(clicker.buttonsDown, []);
});

test('disconnecting releases held buttons', async () => {
    const { clicker, notify, device } = await connectedClicker();
    const log = [];
    clicker.on('disconnected', () => log.push('disconnected'));
    notify.notify(keypad(Buttons.B));
    device.gatt.disconnect();
    assert.equal(clicker.isDown(Buttons.B), false);
    assert.equal(clicker.connected, false);
    assert.deepEqual(log, ['disconnected']);
});

test('resetIdle() treats the current state as nothing pressed', async () => {
    const { clicker, notify } = await connectedClicker();
    notify.notify(keypad(Buttons.Y)); // e.g. a bit that is low at rest on some firmware
    assert.equal(clicker.isDown(Buttons.Y), true);
    clicker.resetIdle();
    assert.equal(clicker.isDown(Buttons.Y), false);
    notify.notify(keypad(Buttons.Y));
    assert.equal(clicker.isDown(Buttons.Y), false);
});

test('ZwiftControllerGroup combines the left and right clickers', async () => {
    const left = await connectedClicker('Zwift Click L');
    const right = await connectedClicker('Zwift Click R');
    const group = new ZwiftControllerGroup();
    const events = [];
    group.on('deviceadded', (e) => events.push(`added ${e.detail.device.name}`));
    group.on('buttondown', (e) => events.push(`${e.detail.device.name} ${e.detail.button}`));
    group.add(left.clicker);
    group.add(right.clicker);

    left.notify.notify(keypad(Buttons.SHIFT_UP_L));
    right.notify.notify(keypad(Buttons.SHIFT_UP_R, Buttons.A));
    right.notify.notify(keypad(Buttons.SHIFT_UP_R));
    right.notify.notify(keypad(Buttons.SHIFT_UP_R, Buttons.A));
    group.update();

    assert.equal(group.isDown(Buttons.SHIFT_UP_L), true);
    assert.equal(group.justPressed(Buttons.SHIFT_UP_R), true);
    assert.equal(group.pressCount(Buttons.A), 2);
    assert.deepEqual(new Set(group.buttonsDown), new Set([Buttons.SHIFT_UP_L, Buttons.SHIFT_UP_R, Buttons.A]));
    assert.deepEqual(events.slice(0, 3), ['added Zwift Click L', 'added Zwift Click R', 'Zwift Click L shiftUpL']);
});
