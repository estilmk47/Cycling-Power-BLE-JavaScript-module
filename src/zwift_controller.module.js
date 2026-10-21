// zwift_controller.module.js - ES module for reading Zwift Click v2 / Zwift Ride buttons via Web Bluetooth.
//
// Usage:
//   import { ZwiftClickerV2, Buttons } from "./src/zwift_controller.module.js";
//
//   const clicker = await ZwiftClickerV2.request();   // must be called from a click handler
//
//   // Game-loop style (poll once per frame):
//   function frame() {
//       clicker.update();
//       if (clicker.justPressed(Buttons.SHIFT_UP_R)) gear++;
//       if (clicker.isDown(Buttons.A)) boost();
//       requestAnimationFrame(frame);
//   }
//
//   // Event style:
//   clicker.on("buttondown", (e) => console.log(e.detail.button));
//
// Two clickers (left + right)? Use ZwiftControllerGroup, it has the same polling API.
//
// Protocol notes (community reverse-engineered, e.g. SwiftControl / qdomyos-zwift):
//   service 0xFC82, char ...0002 = button notifications, ...0003 = write handshake "RideOn",
//   ...0004 = handshake reply. Message = 1 type byte + protobuf. Type 0x23: field 1 is a
//   button bitmap where a CLEARED bit means pressed.

const ZWIFT_SERVICE = 0xfc82;
const ZWIFT_LEGACY_SERVICE = "00000001-19ca-4651-86e5-fa29dcdd09d1";
const SYNC_RX_CHAR = "00000003-19ca-4651-86e5-fa29dcdd09d1";
const BATTERY_LEVEL_CHAR = "00002a19-0000-1000-8000-00805f9b34fb";
const ZWIFT_COMPANY_ID = 0x094a;
const RIDE_ON = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]); // "RideOn"

const MSG_RIDE_KEYPAD = 0x23;
const MSG_CLICK_KEYPAD = 0x37;
const MSG_PLAY_KEYPAD = 0x07;
const MSG_BATTERY = 0x19;

/** Button identifiers. Use these with isDown / justPressed / pressCount etc. */
export const Buttons = Object.freeze({
    LEFT: "left",
    UP: "up",
    RIGHT: "right",
    DOWN: "down",
    A: "a",
    B: "b",
    Y: "y",
    Z: "z",
    SHIFT_UP_L: "shiftUpL",
    SHIFT_DOWN_L: "shiftDownL",
    POWERUP_L: "powerupL",
    ONOFF_L: "onOffL",
    SHIFT_UP_R: "shiftUpR",
    SHIFT_DOWN_R: "shiftDownR",
    POWERUP_R: "powerupR",
    ONOFF_R: "onOffR",
});

// Index = bit number in the button bitmap.
const BIT_TO_BUTTON = [
    Buttons.LEFT, Buttons.UP, Buttons.RIGHT, Buttons.DOWN,
    Buttons.A, Buttons.B, Buttons.Y, Buttons.Z,
    Buttons.SHIFT_UP_L, Buttons.SHIFT_DOWN_L, Buttons.POWERUP_L, Buttons.ONOFF_L,
    Buttons.SHIFT_UP_R, Buttons.SHIFT_DOWN_R, Buttons.POWERUP_R, Buttons.ONOFF_R,
];
const KNOWN_MASK = 0xffff;

const buttonForBit = (bit) => BIT_TO_BUTTON[bit] ?? `bit${bit}`;

// Minimal protobuf decoder: returns [{field, wire, value}]. Varints come back as Numbers (low 53 bits).
function decodeProtobuf(bytes) {
    const out = [];
    let i = 0;
    const readVarint = () => {
        let result = 0n, shift = 0n;
        for (;;) {
            if (i >= bytes.length) throw new Error("truncated varint");
            const b = bytes[i++];
            result |= BigInt(b & 0x7f) << shift;
            if (!(b & 0x80)) return result;
            shift += 7n;
        }
    };
    while (i < bytes.length) {
        const key = Number(readVarint());
        const field = key >> 3, wire = key & 7;
        let value;
        if (wire === 0) value = Number(BigInt.asUintN(53, readVarint()));
        else if (wire === 2) { const len = Number(readVarint()); value = bytes.slice(i, i + len); i += len; }
        else if (wire === 5) { value = bytes.slice(i, i + 4); i += 4; }
        else if (wire === 1) { value = bytes.slice(i, i + 8); i += 8; }
        else throw new Error(`unsupported wire type ${wire}`);
        out.push({ field, wire, value });
    }
    return out;
}

/**
 * One Zwift controller (one physical BLE device).
 *
 * Events (use .on(type, fn) or addEventListener): "buttondown", "buttonup"
 * (detail: {button, bit, device}), "connected", "disconnected", "handshake",
 * "battery" (detail: {level}), "raw" (detail: {bytes}, every notification).
 */
export class ZwiftDevice extends EventTarget {
    /** Options passed to navigator.bluetooth.requestDevice(). */
    static get requestOptions() {
        return {
            filters: [
                { services: [ZWIFT_SERVICE] },
                { services: [ZWIFT_LEGACY_SERVICE] },
                { namePrefix: "Zwift" },
                { manufacturerData: [{ companyIdentifier: ZWIFT_COMPANY_ID }] },
            ],
            optionalServices: [ZWIFT_SERVICE, ZWIFT_LEGACY_SERVICE, "battery_service"],
        };
    }

    /**
     * Opens the browser's device picker, connects and performs the handshake.
     * Must be called from a user gesture (e.g. a click handler).
     */
    static async request(options = {}) {
        const btDevice = await navigator.bluetooth.requestDevice(this.requestOptions);
        const device = new this(btDevice, options);
        await device.connect();
        return device;
    }

    /**
     * @param {BluetoothDevice} bluetoothDevice
     * @param {{handshake?: Uint8Array, debug?: boolean}} options
     */
    constructor(bluetoothDevice, { handshake = RIDE_ON, debug = false } = {}) {
        super();
        this.bluetoothDevice = bluetoothDevice;
        this.handshake = handshake;
        this.debug = debug;
        this.battery = null;      // percent, once known
        this._writeChar = null;
        this._listening = new WeakSet();
        this._everHigh = KNOWN_MASK; // bits seen as 1 (= released); used to work out what "idle" looks like
        this._lastMap = null;
        this._pressedBits = 0;
        this._down = new Set();   // buttons held right now
        this._pending = new Map(); // button -> {presses, releases} since last update()
        this._frame = new Map();   // snapshot taken by update()
        this._onDisconnect = () => this._handleDisconnect();
        bluetoothDevice.addEventListener("gattserverdisconnected", this._onDisconnect);
    }

    get name() { return this.bluetoothDevice.name || this.bluetoothDevice.id; }
    get id() { return this.bluetoothDevice.id; }
    get connected() { return !!this.bluetoothDevice.gatt?.connected; }

    /** Connect (or reconnect), subscribe to notifications and send the handshake. */
    async connect() {
        const server = await this.bluetoothDevice.gatt.connect();
        const services = await server.getPrimaryServices();
        const zwiftUuids = [BluetoothUUID.getService(ZWIFT_SERVICE), ZWIFT_LEGACY_SERVICE];
        let fallbackWrite = null;
        this._writeChar = null;

        for (const svc of services) {
            let chars;
            try { chars = await svc.getCharacteristics(); } catch { continue; }
            for (const c of chars) {
                const p = c.properties;
                if (p.notify || p.indicate) {
                    // Chrome may hand back the same characteristic objects on reconnect; listen only once.
                    if (!this._listening.has(c)) {
                        this._listening.add(c);
                        c.addEventListener("characteristicvaluechanged", (ev) =>
                            this._onData(c, new Uint8Array(ev.target.value.buffer)));
                    }
                    try { await c.startNotifications(); } catch (e) { this._log("subscribe failed", c.uuid, e); }
                }
                if (c.uuid === SYNC_RX_CHAR) this._writeChar = c;
                else if (!fallbackWrite && zwiftUuids.includes(svc.uuid) && (p.write || p.writeWithoutResponse)) fallbackWrite = c;
                if (c.uuid === BATTERY_LEVEL_CHAR && p.read) {
                    try { this._setBattery((await c.readValue()).getUint8(0)); } catch {}
                }
            }
        }
        this._writeChar ??= fallbackWrite;
        if (!this._writeChar) throw new Error("No writable Zwift characteristic found");

        await this.write(this.handshake);
        this._emit("connected");
    }

    disconnect() {
        this.bluetoothDevice.gatt.disconnect();
    }

    /** Write raw bytes to the device's command characteristic. */
    async write(bytes) {
        const c = this._writeChar;
        if (c.properties.write) await c.writeValueWithResponse(bytes);
        else await c.writeValueWithoutResponse(bytes);
    }

    // ---------- polling API (game loop) ----------

    /** Call once per frame. Snapshots everything pressed/released since the previous call. */
    update() {
        this._frame = this._pending;
        this._pending = new Map();
    }

    /** True while the button is held. */
    isDown(button) { return this._down.has(button); }

    /** True if the button went down since the last update() (even if already released again). */
    justPressed(button) { return (this._frame.get(button)?.presses ?? 0) > 0; }

    /** True if the button was released since the last update(). */
    justReleased(button) { return (this._frame.get(button)?.releases ?? 0) > 0; }

    /** Number of presses since the last update() - catches fast double-taps within one frame. */
    pressCount(button) { return this._frame.get(button)?.presses ?? 0; }

    /** Array of buttons currently held. */
    get buttonsDown() { return [...this._down]; }

    /** Treat the current state as "nothing pressed" (in case a button looks stuck). */
    resetIdle() {
        if (this._lastMap !== null) this._everHigh = this._lastMap;
        this._applyPressed(0);
    }

    /** Shorthand for addEventListener that returns an unsubscribe function. */
    on(type, fn) {
        this.addEventListener(type, fn);
        return () => this.removeEventListener(type, fn);
    }

    // ---------- internals ----------

    _onData(char, bytes) {
        if (this.debug) this._log("<-", char.uuid, [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" "));
        this._emit("raw", { bytes, characteristic: char.uuid });

        if (char.uuid === BATTERY_LEVEL_CHAR) return this._setBattery(bytes[0]);
        if (bytes.length >= 6 && RIDE_ON.every((b, i) => bytes[i] === b)) return this._emit("handshake", { bytes });

        let fields;
        try { fields = decodeProtobuf(bytes.slice(1)); } catch { return; }

        switch (bytes[0]) {
            case MSG_RIDE_KEYPAD: {
                const f = fields.find((f) => f.field === 1 && f.wire === 0);
                if (f) this._handleMap(f.value >>> 0);
                break;
            }
            case MSG_CLICK_KEYPAD:
            case MSG_PLAY_KEYPAD: {
                // one varint field per button, 0 = pressed -> bit (field-1) cleared = pressed.
                // Buttons without a field in this message count as released.
                let map = KNOWN_MASK;
                for (const f of fields) {
                    if (f.wire !== 0 || f.field < 1 || f.field > 32) continue;
                    if (f.value === 0) map &= ~(1 << (f.field - 1));
                    else map |= 1 << (f.field - 1);
                }
                this._handleMap(map >>> 0);
                break;
            }
            case MSG_BATTERY: {
                const f = fields.find((f) => f.wire === 0 && f.value <= 100);
                if (f) this._setBattery(f.value);
                break;
            }
        }
    }

    _handleMap(map) {
        this._lastMap = map;
        this._everHigh = (this._everHigh | map) >>> 0;
        this._applyPressed((this._everHigh & ~map) >>> 0);
    }

    _applyPressed(pressed) {
        const changed = (pressed ^ this._pressedBits) >>> 0;
        this._pressedBits = pressed;
        for (let bit = 0; bit < 32; bit++) {
            if (!(changed & (1 << bit))) continue;
            const button = buttonForBit(bit);
            const isDown = !!(pressed & (1 << bit));
            const entry = this._pending.get(button) ?? { presses: 0, releases: 0 };
            if (isDown) { this._down.add(button); entry.presses++; }
            else { this._down.delete(button); entry.releases++; }
            this._pending.set(button, entry);
            this._emit(isDown ? "buttondown" : "buttonup", { button, bit });
        }
    }

    _setBattery(level) {
        this.battery = level;
        this._emit("battery", { level });
    }

    _handleDisconnect() {
        this._applyPressed(0); // release everything so nothing stays stuck
        this._emit("disconnected");
    }

    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail: { ...detail, device: this } }));
    }

    _log(...args) {
        if (this.debug) console.log(`[${this.name}]`, ...args);
    }
}

/** Zwift Click v2. Same protocol as the Zwift Ride, so this is the generic device under a clearer name. */
export class ZwiftClickerV2 extends ZwiftDevice {}

/**
 * Several devices (e.g. the left and right Click v2) combined into one controller.
 * Same polling API as ZwiftDevice; device events are re-dispatched on the group.
 */
export class ZwiftControllerGroup extends EventTarget {
    constructor(DeviceClass = ZwiftClickerV2, options = {}) {
        super();
        this.DeviceClass = DeviceClass;
        this.options = options;
        this.devices = [];
    }

    /** Open the device picker and add the chosen device. Call from a click handler. */
    async requestDevice() {
        const device = await this.DeviceClass.request(this.options);
        this.add(device);
        return device;
    }

    /** Add an already connected device. */
    add(device) {
        this.devices.push(device);
        for (const type of ["buttondown", "buttonup", "connected", "disconnected", "handshake", "battery"]) {
            device.addEventListener(type, (e) => this.dispatchEvent(new CustomEvent(type, { detail: e.detail })));
        }
        this.dispatchEvent(new CustomEvent("deviceadded", { detail: { device } }));
    }

    update() { this.devices.forEach((d) => d.update()); }
    isDown(button) { return this.devices.some((d) => d.isDown(button)); }
    justPressed(button) { return this.devices.some((d) => d.justPressed(button)); }
    justReleased(button) { return this.devices.some((d) => d.justReleased(button)); }
    pressCount(button) { return this.devices.reduce((n, d) => n + d.pressCount(button), 0); }
    get buttonsDown() { return [...new Set(this.devices.flatMap((d) => d.buttonsDown))]; }

    on(type, fn) {
        this.addEventListener(type, fn);
        return () => this.removeEventListener(type, fn);
    }
}
