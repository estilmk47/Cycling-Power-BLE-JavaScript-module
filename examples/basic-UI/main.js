// Basic UI example for ble_devices.module.js + session_tracker.module.js.
// Serve the repository root over http (e.g. `npx serve .` or `python -m http.server`) and open
// http://localhost:<port>/examples/basic-UI/ in Chrome or Edge.

import {
    BluetoothBike, HeartRateMonitor, SimulatedBike, SimulatedHeartRateMonitor, isBluetoothAvailable,
} from '../../src/ble_devices.module.js';
import { Session, SessionTracker, formatDuration } from '../../src/session_tracker.module.js';

const $ = (id) => document.getElementById(id);
const fmt = (value, digits, unit = '') => (value == null || !Number.isFinite(value) ? '--' : value.toFixed(digits) + unit);

let bike = new BluetoothBike();
let heartRateMonitor = new HeartRateMonitor();
const tracker = new SessionTracker({ bike, heartRateMonitor });
let loadedSession = null; // a session imported from file/text, shown while the tracker is idle
let statsRange = 'total';

// Handy for experimenting in the browser console: app.bike.setTargetPower(200), app.tracker.getStats() …
window.app = {
    tracker,
    get bike() { return bike; },
    get heartRateMonitor() { return heartRateMonitor; },
    get session() { return displayedSession(); },
};

function displayedSession() {
    return loadedSession && tracker.state === 'idle' ? loadedSession : tracker.session;
}

let messageTimer = null;
function showMessage(text) {
    const el = $('message');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

if (!isBluetoothAvailable()) {
    showMessage('Web Bluetooth is not available. Use Chrome or Edge over https:// or localhost – or try the simulators.');
}

// --- Devices -------------------------------------------------------------------------------------

function watchErrors(device) {
    device.on('error', (error) => showMessage(`${device.name ?? 'Device'}: ${error.message}`));
    device.on('reconnectfailed', () => showMessage(`${device.name ?? 'Device'}: could not reconnect`));
}
watchErrors(bike);
watchErrors(heartRateMonitor);

async function toggleConnection(device) {
    if (device.state !== 'disconnected') {
        device.disconnect();
        return;
    }
    try {
        await device.connect();
    } catch (error) {
        if (error.name !== 'NotFoundError') showMessage(error.message); // NotFoundError = chooser cancelled
    }
}

function useBike(newBike) {
    bike.disconnect();
    bike = newBike;
    watchErrors(bike);
    tracker.attachBike(bike);
}

function useHeartRateMonitor(newMonitor) {
    heartRateMonitor.disconnect();
    heartRateMonitor = newMonitor;
    watchErrors(heartRateMonitor);
    tracker.attachHeartRateMonitor(heartRateMonitor);
}

$('bike_connect').addEventListener('click', () => {
    if (bike instanceof SimulatedBike) useBike(new BluetoothBike());
    toggleConnection(bike);
});
$('hr_connect').addEventListener('click', () => {
    if (heartRateMonitor instanceof SimulatedHeartRateMonitor) useHeartRateMonitor(new HeartRateMonitor());
    toggleConnection(heartRateMonitor);
});
$('bike_simulate').addEventListener('click', () => {
    if (!(bike instanceof SimulatedBike)) useBike(new SimulatedBike());
    toggleConnection(bike);
});
$('hr_simulate').addEventListener('click', () => {
    if (!(heartRateMonitor instanceof SimulatedHeartRateMonitor)) {
        useHeartRateMonitor(new SimulatedHeartRateMonitor({ bike: { get power() { return bike.power; } } }));
    }
    toggleConnection(heartRateMonitor);
});

function renderDevice(device, cardId, nameId, statusId, defaultName, connectButtonId) {
    const card = $(cardId);
    card.classList.toggle('connected', device.isConnected);
    card.classList.toggle('connecting', device.isConnecting);
    $(nameId).textContent = device.state === 'disconnected' ? defaultName : (device.name ?? defaultName);
    const battery = device.batteryLevel != null ? ` · battery ${device.batteryLevel}%` : '';
    $(statusId).textContent = device.state + battery;
    $(connectButtonId).textContent = device.state === 'disconnected' ? 'Connect' : 'Disconnect';
}

function renderCapabilities() {
    const el = $('capabilities');
    if (!bike.isConnected) {
        el.innerHTML = '';
        return;
    }
    const caps = bike.capabilities;
    const protocols = Object.entries(caps.protocols).filter(([, on]) => on).map(([name]) => name);
    const data = Object.entries(caps.data).filter(([, on]) => on).map(([name]) => name);
    const control = Object.entries(caps.control).filter(([, on]) => on).map(([name]) => name);
    const html = [
        ...protocols.map((name) => `<span title="protocol">${name}</span>`),
        ...data.map((name) => `<span title="measurement">${name}${bike.available[name] ? ' ✓' : ''}</span>`),
        ...control.map((name) => `<span class="control" title="control">set ${name}</span>`),
    ].join('');
    if (el.innerHTML !== html) el.innerHTML = html;
}

// --- Trainer control -----------------------------------------------------------------------------

const CONTROL_MODES = {
    resistance: { capability: 'resistance', min: 0, max: 100, step: 1, value: 30, unit: ' %', apply: (v) => bike.setResistancePercent(v) },
    power: { capability: 'targetPower', min: 50, max: 600, step: 5, value: 150, unit: ' W', apply: (v) => bike.setTargetPower(v) },
    grade: { capability: 'simulation', min: -10, max: 20, step: 0.5, value: 0, unit: ' %', apply: (v) => bike.setGrade(v) },
};

function selectControlMode(name) {
    const mode = CONTROL_MODES[name];
    const slider = $('control_value');
    Object.assign(slider, { min: mode.min, max: mode.max, step: mode.step, value: mode.value });
    $('control_output').textContent = mode.value + mode.unit;
}
selectControlMode($('control_mode').value);

$('control_mode').addEventListener('change', (event) => selectControlMode(event.target.value));
$('control_value').addEventListener('input', (event) => {
    const mode = CONTROL_MODES[$('control_mode').value];
    $('control_output').textContent = event.target.value + mode.unit;
});
$('control_value').addEventListener('change', async (event) => {
    const mode = CONTROL_MODES[$('control_mode').value];
    mode.value = Number(event.target.value);
    try {
        await mode.apply(mode.value);
    } catch (error) {
        showMessage(error.message);
    }
});

function renderControl() {
    const control = bike.isConnected ? bike.capabilities.control : {};
    for (const option of $('control_mode').options) {
        option.disabled = !control[CONTROL_MODES[option.value].capability];
    }
    const supported = !!control[CONTROL_MODES[$('control_mode').value].capability];
    $('control_mode').disabled = !bike.isConnected;
    $('control_value').disabled = !supported;
}

// --- Session -------------------------------------------------------------------------------------

$('start').addEventListener('click', () => {
    loadedSession = null;
    tracker.start();
});
$('lap').addEventListener('click', () => tracker.lap());
$('pause').addEventListener('click', () => tracker.togglePause());
$('stop').addEventListener('click', () => tracker.stop());
$('new').addEventListener('click', () => {
    tracker.reset();
    loadedSession = null;
    $('loaded_info').textContent = '';
});
$('session_data').addEventListener('click', () => {
    statsRange = statsRange === 'total' ? 'lap' : 'total';
});

function renderSessionButtons() {
    const state = tracker.state;
    const show = {
        start: state === 'idle',
        lap: state === 'running' || state === 'paused',
        pause: state === 'running' || state === 'paused',
        stop: state === 'running' || state === 'paused',
        new: state === 'stopped',
    };
    for (const [id, visible] of Object.entries(show)) $(id).hidden = !visible;
    $('pause').textContent = state === 'paused' ? 'CONTINUE' : 'PAUSE';
}

function renderTimes(session) {
    const now = new Date();
    $('clock_time').textContent = now.toTimeString().slice(0, 8);
    if (session.startTime == null) {
        $('total_time').textContent = $('lap_time').textContent = '--:--:--';
        return;
    }
    const total = session.getStats('total');
    const lap = session.getStats('lap');
    $('total_time').textContent = formatDuration(total.elapsedTime);
    $('lap_time').textContent = formatDuration(lap.elapsedTime);
}

function renderStats(session) {
    const lapCount = session.laps.length;
    const stats = session.getStats(statsRange);
    $('session_data_lap_total').textContent = statsRange === 'total' ? 'Total' : `Lap ${Math.max(1, lapCount)}`;
    $('active_time').textContent = `${formatDuration(stats.activeTime)} active`;
    $('elapsed_time').textContent = `${formatDuration(stats.elapsedTime)} elapsed`;
    $('energy').textContent = fmt(stats.energy, 1, ' kJ');
    $('calories').textContent = fmt(stats.calories, 0, ' kcal');
    $('distance').textContent = fmt(stats.distance / 1000, 2, ' km');
    $('speed').textContent = fmt(stats.speed.avg, 1, ' km/h AVG');
    $('heart_rate_max').textContent = fmt(stats.heartRate.max, 0, ' MAX');
    $('heart_rate_avg').textContent = fmt(stats.heartRate.avg, 0, ' AVG');
    $('cadence_max').textContent = fmt(stats.cadence.max, 0, ' MAX');
    $('cadence_avg').textContent = fmt(stats.cadence.avg, 0, ' AVG');
    $('power_max').textContent = fmt(stats.power.max, 0, ' MAX');
    $('power_avg').textContent = fmt(stats.power.avg, 0, ' AVG');
}

function renderLive() {
    const current = tracker.current;
    $('live_power').textContent = fmt(current.power, 0);
    $('live_cadence').textContent = fmt(current.cadence, 0);
    $('live_speed').textContent = fmt(current.speed, 1);
    $('live_hr').textContent = fmt(current.heartRate, 0);
}

// --- Graph: power and heart rate of the last 5 minutes (whole session when loaded) --------------

const canvas = $('canvas');
const ctx = canvas.getContext('2d');

function drawGraph(session) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * ratio;
    const height = canvas.clientHeight * ratio;
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    ctx.clearRect(0, 0, width, height);
    if (session.startTime == null) return;

    const end = session.duration;
    const span = session === loadedSession ? Math.max(end, 1) : 5 * 60 * 1000;
    const from = Math.max(0, end - span);
    const x = (t) => ((t - from) / span) * width;

    const bikeSamples = session.bikeSamples.filter((s) => s.t >= from);
    const heartSamples = session.heartRateSamples.filter((s) => s.t >= from);
    const maxPower = bikeSamples.reduce((max, s) => Math.max(max, s.power ?? 0), 400);

    // Lap markers
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = ratio;
    for (const lap of session.laps.slice(1)) {
        if (lap.start < from) continue;
        ctx.beginPath();
        ctx.moveTo(x(lap.start), 0);
        ctx.lineTo(x(lap.start), height);
        ctx.stroke();
    }

    const line = (samples, key, color, toY) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * ratio;
        ctx.beginPath();
        let drawing = false;
        for (const s of samples) {
            if (s[key] == null) { drawing = false; continue; }
            if (drawing) ctx.lineTo(x(s.t), toY(s[key])); else ctx.moveTo(x(s.t), toY(s[key]));
            drawing = true;
        }
        ctx.stroke();
    };
    line(bikeSamples, 'power', '#9B6BFF', (p) => height - (p / maxPower) * height * 0.9);
    line(heartSamples, 'heartRate', '#E0475B', (hr) => height - ((hr - 40) / 160) * height * 0.9);

    ctx.fillStyle = '#B1B1B1';
    ctx.font = `${12 * ratio}px monospace`;
    ctx.fillText(`power (0–${Math.round(maxPower)} W)`, 8 * ratio, 16 * ratio);
    ctx.fillStyle = '#E0475B';
    ctx.fillText('heart rate (40–200 bpm)', 8 * ratio, 32 * ratio);
}

// --- Export / import -----------------------------------------------------------------------------

function exportable() {
    const session = displayedSession();
    if (session.startTime == null) throw new Error('Nothing to export yet – start (and stop) a session first.');
    return session;
}

$('download_tcx').addEventListener('click', () => {
    try { exportable().downloadTCX(); } catch (error) { showMessage(error.message); }
});
$('download_ride').addEventListener('click', () => {
    try { exportable().downloadBinary(); } catch (error) { showMessage(error.message); }
});
$('copy_base64').addEventListener('click', async () => {
    try {
        const text = exportable().toBase64();
        await navigator.clipboard.writeText(text);
        showMessage(`Copied ${text.length} characters to the clipboard.`);
    } catch (error) {
        showMessage(error.message);
    }
});

function load(session) {
    if (tracker.state !== 'idle') {
        showMessage('Finish the current session (STOP → NEW) before loading another one.');
        return;
    }
    loadedSession = session;
    const stats = session.getStats();
    $('loaded_info').textContent = `Loaded session from ${new Date(session.startTime).toLocaleString()}: `
        + `${session.bikeSamples.length} bike samples, ${session.heartRateSamples.length} heart-rate samples, `
        + `${session.laps.length} laps, ${formatDuration(stats.elapsedTime)}.`;
}

$('import_paste').addEventListener('click', () => {
    try { load(Session.parse($('import_text').value)); } catch (error) { showMessage(error.message); }
});
$('import_file').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try { load(await Session.fromFile(file)); } catch (error) { showMessage(error.message); }
    event.target.value = '';
});

// --- Render loop (4 Hz is plenty for a dashboard) ------------------------------------------------

function render() {
    const session = displayedSession();
    renderDevice(bike, 'bike_card', 'bike_name', 'bike_status', 'Bike', 'bike_connect');
    renderDevice(heartRateMonitor, 'hr_card', 'hr_name', 'hr_status', 'Heart Rate Monitor', 'hr_connect');
    renderCapabilities();
    renderControl();
    renderLive();
    renderSessionButtons();
    renderTimes(session);
    renderStats(session);
    drawGraph(session);
}
render();
setInterval(render, 250);
