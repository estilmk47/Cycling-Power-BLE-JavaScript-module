# Cycling-Power-BLE-JavaScript-module

Vanilla JavaScript modules for connecting a web page to **smart bike trainers, spin bikes, power meters, speed/cadence
sensors, heart-rate monitors and Zwift Click v2 / Zwift Ride controllers** over Web Bluetooth, and for **recording
training sessions** with full and per-lap statistics, TCX export and a compact binary format.

- **Zero dependencies, no build step, no UI.** Plain ES modules you import and build your own interface (or game) on.
- **Reads** power, cadence, speed, distance, energy, resistance and heart rate (including RR intervals).
- **Controls** FTMS trainers: resistance, ERG (target power), simulation (gradient/wind), inclination, speed.
- **Reports capabilities**: what the bike says it supports and what data has actually arrived.
- **Records every data point**, with heart rate kept as its own time series.
- **Exports** TCX (Strava, Garmin Connect, TrainingPeaks), RIDE binary (databases), base64 (copy/paste) and JSON.
- **Simulated bike and heart-rate monitor** with the same API, for development without hardware.
- **Zwift Click v2 / Ride buttons** as a game controller, with a per-frame polling API and events.

| Module | Contents |
| --- | --- |
| [`src/ble_devices.module.js`](src/ble_devices.module.js) | `BluetoothBike`, `HeartRateMonitor`, `SimulatedBike`, `SimulatedHeartRateMonitor`, `BleDevice` base class, packet parsers |
| [`src/session_tracker.module.js`](src/session_tracker.module.js) | `SessionTracker`, `Session`, TCX/RIDE/base64/JSON import & export, `formatDuration` |
| [`src/zwift_controller.module.js`](src/zwift_controller.module.js) | `ZwiftClickerV2`, `ZwiftDevice`, `ZwiftControllerGroup`, `Buttons` |

---

## Contents

- [Browser support](#browser-support)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Example applications](#example-applications)
- [Devices: `ble_devices.module.js`](#devices-ble_devicesmodulejs)
- [Sessions: `session_tracker.module.js`](#sessions-session_trackermodulejs)
- [Controllers: `zwift_controller.module.js`](#controllers-zwift_controllermodulejs)
- [Export formats](#export-formats)
- [Using it in a game](#using-it-in-a-game)
- [Development](#development)
- [Migrating from version 1](#migrating-from-version-1)

## Browser support

Web Bluetooth is available in **Chrome, Edge, Opera and other Chromium browsers** on Windows, macOS, Linux, ChromeOS
and Android. It is not available in Firefox or Safari (on iOS, the Bluefy browser works).

- The page must be served over **https://** or from **http://localhost**.
- `connect()` opens the browser's device chooser and must be called from a **user gesture** (e.g. a click handler).
- The session module has no browser requirements apart from `downloadTCX()`/`downloadBinary()`; it also runs in Node.js ≥ 19.

## Installation

The modules are plain files – copy `src/` into your project, or import them directly:

```js
// From a CDN (pin a tag or commit in production)
import { BluetoothBike } from 'https://cdn.jsdelivr.net/gh/estilmk47/Cycling-Power-BLE-JavaScript-module@main/src/ble_devices.module.js';
import { SessionTracker } from 'https://cdn.jsdelivr.net/gh/estilmk47/Cycling-Power-BLE-JavaScript-module@main/src/session_tracker.module.js';
import { ZwiftControllerGroup } from 'https://cdn.jsdelivr.net/gh/estilmk47/Cycling-Power-BLE-JavaScript-module@main/src/zwift_controller.module.js';
```

```bash
# With npm, straight from GitHub
npm install github:estilmk47/Cycling-Power-BLE-JavaScript-module
```

```js
import { BluetoothBike, HeartRateMonitor } from 'cycling-power-ble/devices';
import { SessionTracker, Session } from 'cycling-power-ble/session';
import { ZwiftControllerGroup, Buttons } from 'cycling-power-ble/zwift';
```

## Quick start

```html
<button id="bike">Connect bike</button>
<button id="hr">Connect heart rate</button>
<button id="start">Start</button> <button id="lap">Lap</button> <button id="stop">Stop</button>
<pre id="out"></pre>

<script type="module">
import { BluetoothBike, HeartRateMonitor } from './src/ble_devices.module.js';
import { SessionTracker } from './src/session_tracker.module.js';

const bike = new BluetoothBike();
const heartRateMonitor = new HeartRateMonitor();
const tracker = new SessionTracker({ bike, heartRateMonitor });

document.getElementById('bike').onclick = () => bike.connect();            // opens the device chooser
document.getElementById('hr').onclick = () => heartRateMonitor.connect();
document.getElementById('start').onclick = () => tracker.start();
document.getElementById('lap').onclick = () => tracker.lap();
document.getElementById('stop').onclick = () => { tracker.stop(); tracker.downloadTCX(); };

bike.on('data', ({ power, cadence, speed }) => {
    const total = tracker.getStats('total');
    const lap = tracker.getStats('lap');
    document.getElementById('out').textContent =
        `${power} W  ${cadence?.toFixed(0)} rpm  ${speed?.toFixed(1)} km/h\n` +
        `total: ${(total.distance / 1000).toFixed(2)} km, avg ${total.power.avg?.toFixed(0)} W\n` +
        `lap:   ${(lap.distance / 1000).toFixed(2)} km, avg ${lap.power.avg?.toFixed(0)} W`;
});
</script>
```

## Example applications

[`examples/basic-UI`](examples/basic-UI) is a complete dashboard: device connection with simulator fallback,
capability display, live values, a power/heart-rate graph, trainer control (resistance / ERG / gradient), session
controls, total/lap statistics, and TCX/RIDE export and import.

```bash
# from the repository root
npx serve .            # or: python -m http.server 8000
# open http://localhost:3000/examples/basic-UI/ (or :8000) in Chrome or Edge
```

No trainer at hand? Click **Simulator** on the bike and heart-rate cards.

[`examples/controller-simple-counter`](examples/controller-simple-counter) connects one or two Zwift Click v2
controllers, counts button presses and shifts a virtual gear – open `/examples/controller-simple-counter/` on the same
server.

---

## Devices: `ble_devices.module.js`

### Supported devices

| Bluetooth profile | Typical devices | Data | Control |
| --- | --- | --- | --- |
| Fitness Machine Service (FTMS, `0x1826`) | Wahoo KICKR, Tacx Neo/Flux, Elite, Zwift Hub, Saris, most spin bikes since ~2019 | power, cadence, speed, distance, resistance, heart rate | ✓ |
| Cycling Power Service (`0x1818`) | power meters, older trainers | power, cadence, speed (from revolutions), pedal balance, torque | – |
| Cycling Speed and Cadence (`0x1816`) | speed and cadence sensors | cadence, speed | – |
| Heart Rate Service (`0x180D`) | chest straps, watches, arm bands | heart rate, RR intervals, energy expended | – |

A `BluetoothBike` subscribes to **every** supported profile the device offers and merges them: for each metric the
best source wins (FTMS › Cycling Power › Speed & Cadence) as long as it keeps sending. Battery level and device
information (manufacturer, model, firmware) are read when available.

### Connecting

```js
const bike = new BluetoothBike({
    wheelCircumference: 2.105, // m – for speed/distance from wheel revolutions (700×25c)
    staleTimeout: 3000,        // ms without updates before power/cadence/speed read as 0
    autoReconnect: true,       // reconnect automatically after an unexpected disconnect
    reconnectAttempts: 5,
});

button.onclick = async () => {
    try {
        await bike.connect();                 // chooser → connect → discover → subscribe
        console.log(bike.name, bike.info, bike.batteryLevel);
    } catch (error) {
        if (error.name !== 'NotFoundError') console.error(error); // NotFoundError: chooser cancelled
    }
};

bike.disconnect();     // on purpose – no automatic reconnection
await bike.reconnect(); // the same device again, without the chooser
```

| Property | Description |
| --- | --- |
| `state` | `'disconnected'` · `'connecting'` · `'connected'` |
| `isConnected`, `isConnecting` | booleans |
| `name`, `id`, `device` | device name, Web Bluetooth id, the underlying `BluetoothDevice` |
| `info` | `{manufacturer, model, hardwareRevision, firmwareRevision, softwareRevision}` where readable |
| `batteryLevel` | % or `null` |
| `timestamp` | `Date.now()` of the latest data notification |

**Events** – `device.on(type, listener)` returns an unsubscribe function; the listener gets `event.detail`
(`addEventListener` works too):

| Event | Detail |
| --- | --- |
| `data` | the new data snapshot (see below) – fired for every notification |
| `statechange` | `{state}` |
| `connect` | `{name}` |
| `disconnect` | `{expected}` – `false` when the device dropped out |
| `reconnecting` / `reconnectfailed` | `{attempt, delay}` / `{attempts}` |
| `battery` | `{level}` |
| `control` (bike) | the new target, e.g. `{mode: 'power', power: 200}` |
| `status` (bike) | FTMS machine status `{opCode, status, parameters}`, e.g. a target changed by another app |
| `error` | `Error` thrown while handling a notification or reconnecting |

### Reading data

```js
bike.power;      // W
bike.cadence;    // rpm
bike.speed;      // km/h
bike.distance;   // m since connecting
bike.energy;     // kJ of mechanical work since connecting (integrated from power)
bike.resistance; // trainer resistance level (device units), when reported
bike.heartRate;  // bpm, when the trainer forwards a heart-rate strap

bike.data;       // frozen snapshot {timestamp, power, cadence, speed, distance, energy, resistance, heartRate}
bike.on('data', (snapshot) => { /* every notification, typically 1–4 per second */ });
```

Values are `null` until the first measurement. Power, cadence and speed drop to `0` when nothing has arrived for
`staleTimeout` ms (you stopped pedalling, or the trainer went quiet).

### What does my bike support?

```js
bike.capabilities;   // what the device declares (available right after connect())
bike.available;      // what has actually arrived so far, e.g. {power: true, cadence: true, speed: true, ...}
bike.rawData;        // last parsed packet per profile: {ftms, cyclingPower, cyclingSpeedCadence}
```

`capabilities` has this shape:

```js
{
  protocols: { ftms: true, cyclingPower: true, cyclingSpeedCadence: false, simulated: false },
  data:      { power, cadence, speed, distance, energy, resistance, heartRate, pedalPowerBalance, torque },   // booleans
  control:   { resistance, targetPower, simulation, inclination, targetSpeed, wheelCircumference, startStop }, // booleans
  ranges:    { resistance: {min, max, increment} | null, power: {...} | null, inclination: {...} | null, speed: {...} | null },
  features:  { ftms: {machine: {...}, target: {...}} | null, cyclingPower: {...} | null, cyclingSpeedCadence: {...} | null }
}
```

`features` holds every bit of the devices' feature characteristics, decoded by name, for anything not summarised above.

### Controlling the trainer

All control methods are `async`. Control of the trainer is requested automatically, commands are queued (Bluetooth
allows one at a time), values are clamped to the supported ranges, and each call resolves when the trainer confirms.

```js
if (bike.capabilities.control.targetPower) await bike.setTargetPower(200);  // ERG mode
if (bike.capabilities.control.simulation) await bike.setGrade(4.5);         // 4.5 % climb
await bike.setSimulation({ grade: -2, windSpeed: 3, crr: 0.004, windResistance: 0.51 });
await bike.setResistancePercent(40);                                        // 0–100 % of the supported range
await bike.setResistance(12.5);                                             // in the trainer's own units
```

| Method | Requires `capabilities.control.*` | Notes |
| --- | --- | --- |
| `setResistance(level)` | `resistance` | Device units, 0.1 resolution, see `ranges.resistance` |
| `setResistancePercent(percent)` | `resistance` | Maps 0–100 % onto `ranges.resistance` |
| `setTargetPower(watts)` | `targetPower` | ERG mode |
| `setSimulation({grade, windSpeed, crr, windResistance})` | `simulation` | grade %, wind m/s (headwind +), rolling resistance, CdA·ρ/2 in kg/m. Unspecified values are kept |
| `setGrade(percent)` | `simulation` | Shortcut for `setSimulation({grade})` |
| `setTargetInclination(percent)` | `inclination` | For trainers that tilt |
| `setTargetSpeed(kmh)` | `targetSpeed` | |
| `setWheelCircumference(meters)` | – | Updates local speed/distance; also sent to the trainer when supported |
| `startTraining()`, `pauseTraining()`, `stopTraining()`, `resetTrainer()` | `startStop` | FTMS start/stop/reset |
| `sendControlCommand(opCode, payloadBytes)` | – | Raw FTMS control point command (see `FTMS_OPCODE`) |

`bike.target` returns the last target sent (`{mode: 'resistance' | 'power' | 'simulation' | 'inclination' | 'speed' | null, ...}`).
Unsupported or rejected commands throw a `BleControlError` with `opCode`, `resultCode` and `result`
(`'op-code-not-supported'`, `'invalid-parameter'`, `'operation-failed'`, `'control-not-permitted'`).

> The FTMS 1.0 specification describes the resistance parameter of "Set Target Resistance Level" ambiguously; most
> trainers expect a signed 16-bit value (the default). If yours rejects resistance commands, try
> `new BluetoothBike({ resistanceFormat: 'uint8' })`.

### Heart-rate monitor

```js
const hrm = new HeartRateMonitor({ staleTimeout: 5000 });
await hrm.connect();
hrm.heartRate;        // bpm (null without skin contact or after staleTimeout)
hrm.rrIntervals;      // RR intervals in ms from the latest notification (for HRV)
hrm.energyExpended;   // kJ, if the strap reports it
hrm.contactDetected;  // true / false / null (not supported)
hrm.capabilities;     // {bodySensorLocation, rrIntervals, energyExpended, contactDetection}
hrm.data;             // {timestamp, heartRate, rrIntervals, energyExpended, contactDetected}
hrm.on('data', (snapshot) => {});
```

Connection handling, events, `info` and `batteryLevel` work as for the bike.

### Simulators

`SimulatedBike` and `SimulatedHeartRateMonitor` have the same API as the real devices (properties, events, control
methods), so an application can be developed and tested without hardware – and in Node.js.

```js
const bike = new SimulatedBike({ interval: 1000, riderMass: 80 });
const hrm = new SimulatedHeartRateMonitor({ bike, restingHeartRate: 60, maxHeartRate: 190, ftp: 250 });
await bike.connect();
await bike.setTargetPower(220);
bike.targetCadence = 95;   // the virtual rider's cadence
bike.pedaling = false;     // stop pedalling
```

Speed is computed from power and gradient with a simple road model, so `setGrade()` behaves like a real hill.

### Supporting other devices

Extend `BleDevice` to add any Bluetooth device with the same connection handling, reconnection and events:

```js
import { BleDevice } from './src/ble_devices.module.js';

class SteeringController extends BleDevice {
    static requestOptions() {
        return { filters: [{ services: ['be30f8d4-4711-11ee-be56-0242ac120002'] }] };
    }
    async _onConnected(server) {
        const service = await this._getService(server, 'be30f8d4-4711-11ee-be56-0242ac120002');
        const output = await this._getCharacteristic(service, 'be30f8d4-4711-11ee-be56-0242ac120003');
        await this._subscribe(output, (view) => {
            this.angle = view.getInt8(3);
            this._touch();                        // updates timestamp
            this._emit('data', { angle: this.angle, timestamp: this.timestamp });
        });
    }
    _onDisconnected() { this.angle = null; }
}
```

### Low-level exports

- Packet parsers (accept `DataView`, `ArrayBuffer`, typed arrays or `number[]`): `parseIndoorBikeData`,
  `parseCyclingPowerMeasurement`, `parseCscMeasurement`, `parseHeartRateMeasurement`, `parseFitnessMachineFeature`,
  `parseCyclingPowerFeature`, `parseCscFeature`, `parseSupportedRange`.
- `RevolutionCounter` – cumulative revolutions + event time → rate, with roll-over handling.
- Constants: `SERVICE`, `CHARACTERISTIC`, `FTMS_OPCODE`, `CONNECTION_STATE`.
- `isBluetoothAvailable()`, `isBluetoothEnabled()`.

---

## Sessions: `session_tracker.module.js`

### Recording

```js
const tracker = new SessionTracker({ bike, heartRateMonitor, pollInterval: 500 });

tracker.start();
tracker.lap();          // lap flag – returns the new lap index
tracker.pause();        // or tracker.togglePause()
tracker.resume();
tracker.stop();
const finished = tracker.reset(); // returns the old Session and starts a fresh one

tracker.attachBike(otherBike);        // devices can be attached/swapped/detached (null) at any time
tracker.state;                        // 'idle' | 'running' | 'paused' | 'stopped'
tracker.current;                      // {power, cadence, speed, resistance, heartRate} – live values
tracker.session;                      // the Session being recorded
tracker.on('sample', ({ kind, sample }) => {}); // also: start, pause, resume, lap, stop, reset, statechange
tracker.destroy();                    // remove timers and listeners
```

**How samples are recorded.** The tracker records every `data` notification from the devices the moment it arrives,
so no data point is lost. As a fallback it also polls `device.data` every `pollInterval` ms (default 500 ms) and
records the snapshot when its `timestamp` has changed – this is what makes plain objects without events work, and
duplicates are ignored. Event-driven recording matters because sensors don't send at an exact 1 Hz: a power meter may
send 2–4 times per second and FTMS trainers sometimes split one measurement across two notifications, which a fixed
2 Hz poll could miss. Heart-rate RR intervals are only correct if every notification is kept.

**Heart rate** is stored as its own time series (`session.heartRateSamples`) with its own timestamps. Nothing is
interpolated or matched while recording; the two series are only combined when exporting TCX (each trackpoint takes
the latest heart rate that is at most 5 s old).

**Distance** in the session starts at 0 at `start()` and does not jump when a device reconnects or resets its counter.

### Statistics

```js
tracker.getStats();         // whole session  (same as getStats('total'))
tracker.getStats('lap');    // since the last lap flag
tracker.getStats(0);        // a specific lap by index
tracker.getLapStats();      // array with every lap
```

Each call returns:

```js
{
  lap: null,                // lap index, null for the total
  startTime, endTime,       // ms since epoch; endTime is null while the period is open
  elapsedTime,              // ms including pauses
  activeTime,               // ms excluding pauses
  distance,                 // m
  energy,                   // kJ of mechanical work
  calories,                 // kcal burned (estimate: energy / 4.184 / Session.grossEfficiency, default 24 %)
  power:     { avg, max, min },
  cadence:   { avg, max, min }, // the average ignores zeros (coasting)
  speed:     { avg, max, min },
  heartRate: { avg, max, min },
  samples:   { bike, heartRate }
}
```

Averages are **time-weighted**: each sample counts for the time since the previous sample (Bluetooth sensors report
the average over that interval), gaps longer than `Session.maxSampleGap` (5 s) count as at most 5 s, and paused time
counts as nothing. Statistics are updated incrementally, so calling `getStats()` every animation frame is cheap.

### The `Session` data model

`Session` is plain data, independent of devices. A tracker fills it, but you can also create, load, edit and analyse
sessions directly:

```js
session.startTime / session.endTime   // ms since epoch
session.events                        // [{t, type: 'start' | 'pause' | 'resume' | 'lap' | 'stop'}]
session.bikeSamples                   // [{t, power, cadence, speed, distance, resistance}]
session.heartRateSamples              // [{t, heartRate, rr: [ms, ...]}]
session.meta                          // any JSON: title, notes, devices, your own fields
session.laps                          // [{index, start, end}]
session.state, session.duration
```

`t` is milliseconds since `startTime`; missing values are `null`.

**Recording without the tracker** (e.g. from a game's own physics): `session.start(time)`, `pause()`, `resume()`,
`lap()`, `stop()`, `addBikeSample({t, power, ...})`, `addHeartRateSample({t, heartRate, rr})`.

**Editing**: `insertLap(t)`, `removeLap(index)`, `crop(from, to)`, `clone()`. If you change the arrays directly,
call `session.invalidate()` so statistics are recalculated.

## Controllers: `zwift_controller.module.js`

Reads the buttons of the **Zwift Click v2** (left and right units) and the **Zwift Ride** handlebar controllers.
Messages in the older Zwift Click (v1) and Zwift Play format are decoded too. The protocol is community
reverse-engineered (as used by SwiftControl and qdomyos-zwift), not an official specification.

```js
import { ZwiftControllerGroup, ZwiftClickerV2, Buttons } from './src/zwift_controller.module.js';

// One controller made of both Click units – call requestDevice() once per unit, from a click handler
const controller = new ZwiftControllerGroup();
connectButton.onclick = () => controller.requestDevice();

// Game-loop style: snapshot once per frame, then query
function frame() {
    controller.update();
    gear += controller.pressCount(Buttons.SHIFT_UP_R) - controller.pressCount(Buttons.SHIFT_UP_L);
    if (controller.isDown(Buttons.A)) boost();
    requestAnimationFrame(frame);
}

// Event style
controller.on('buttondown', (e) => console.log(e.detail.button, e.detail.device.name));

// A single device without a group
const clicker = await ZwiftClickerV2.request();
```

| Polling (after `update()`) | |
| --- | --- |
| `isDown(button)` | held right now |
| `justPressed(button)` / `justReleased(button)` | changed since the previous `update()` |
| `pressCount(button)` | presses since the previous `update()` – fast double taps within one frame are not lost |
| `buttonsDown` | array of held buttons |

`Buttons`: `LEFT`, `UP`, `RIGHT`, `DOWN`, `A`, `B`, `Y`, `Z`, `SHIFT_UP_L`, `SHIFT_DOWN_L`, `POWERUP_L`, `ONOFF_L`,
`SHIFT_UP_R`, `SHIFT_DOWN_R`, `POWERUP_R`, `ONOFF_R`.

Events (`on(type, fn)` / `addEventListener`, payload in `event.detail` with `device`): `buttondown`, `buttonup`
(`{button, bit}`), `connected`, `disconnected`, `handshake`, `battery` (`{level}`), `raw` (`{bytes}`, single devices
only); the group also fires `deviceadded`. `device.battery` holds the battery %, `device.connect()` reconnects,
`device.resetIdle()` clears a button that looks stuck, and `new ZwiftClickerV2(bluetoothDevice, { debug: true })`
logs every notification. On disconnect all held buttons are released.

> Unlike the other modules, `on()` listeners here receive the event itself – read the payload from `e.detail`.

## Export formats

| Format | Write | Read | Use for |
| --- | --- | --- | --- |
| TCX | `toTCX()`, `downloadTCX(filename?)` | – | Strava, Garmin Connect, TrainingPeaks, intervals.icu |
| RIDE binary | `toBinary()`, `downloadBinary(filename?)` | `Session.fromBinary(bytes)` | databases, files, lossless archive |
| Base64 text | `toBase64()` | `Session.fromBase64(text)` | clipboard, text-only storage |
| JSON | `toJSON()` / `JSON.stringify(session)` | `Session.fromJSON(json)` | debugging, analysis |
| any of the above | | `Session.parse(text)`, `await Session.fromFile(file)` | user imports |

The methods exist on both `Session` and `SessionTracker`.

The TCX export contains one `<Lap>` per lap (time, distance, max speed, calories, average/max heart rate, average
cadence, average/max power) and one `<Trackpoint>` per bike sample (time with milliseconds, distance, heart rate,
cadence, speed and power).

**RIDE** is this project's binary format: a 24-byte header, `META`/`EVNT`/`BIKE`/`HRTR` chunks and a CRC-32 checksum,
about 120 kB per hour.

- 📄 [Format specification](docs/binary-format.md) – byte layout, rules, worked example, Python decoder, database schema
- 🧭 [User guide](docs/binary-format-guide.html) – saving, sharing, editing and storing sessions, with a drag-and-drop session inspector (open it in a browser)

## Using it in a game

The devices are plain objects you can read every frame, the simulators make development possible without a bike,
and the Zwift controller works as a gamepad:

```js
const bike = useHardware ? new BluetoothBike() : new SimulatedBike();
const tracker = new SessionTracker({ bike });
const controller = new ZwiftControllerGroup();

function animate() {
    const { power, speed } = bike.data;           // W, km/h
    player.thrust = (power ?? 0) * powerToThrust;
    controller.update();                          // Zwift Click v2 as gamepad
    if (controller.justPressed(Buttons.POWERUP_R)) player.usePowerUp();
    requestAnimationFrame(animate);
}

// Make the trainer feel the terrain (throttle: a few updates per second is plenty)
setInterval(() => {
    if (bike.capabilities.control.simulation) bike.setGrade(terrain.slopeAt(player.position)).catch(() => {});
}, 1000);
```

## Development

```
src/                                devices, session tracker and Zwift controller modules
test/                               node:test unit tests (fake GATT servers, simulators)
docs/binary-format.md               RIDE format specification
docs/binary-format-guide.html       RIDE user guide and inspector
examples/basic-UI/                  example dashboard
examples/controller-simple-counter/ Zwift Click v2 button counter
```

```bash
npm test     # node --test test/   (Node.js ≥ 19)
```

## Migrating from version 1

Version 2 is a rewrite; the single `cycling_power_ble.module.js` was split into two modules and the built-in UI removed.

| Version 1 | Version 2 |
| --- | --- |
| `new Session()` (owned bike + HR) | `new SessionTracker({ bike: new BluetoothBike(), heartRateMonitor: new HeartRateMonitor() })` |
| `session.bike.connect()` | `bike.connect()` (now returns a promise) |
| `bike.setMode(Bike.MODES.FILTERED)` | removed – values are raw; smooth in your UI if needed |
| `bike.powerAvailable` etc. | `bike.capabilities.data.power`, `bike.available.power` |
| `HeartRate` | `HeartRateMonitor` |
| `session.getStats()` → `{total, lap, current}` | `tracker.getStats('total')`, `tracker.getStats('lap')`, `tracker.current` |
| `session.new()` | `tracker.reset()` |
| `downloadTCX(session.sessionData)` | `tracker.downloadTCX()` |
| `formatTime(ms)` | `formatDuration(ms)` |
| `Joule2Cal(kJ)` | `stats.calories` |

## License

[MIT](LICENSE) © estilmk47
