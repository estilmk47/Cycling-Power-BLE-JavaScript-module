/**
 * @file session_tracker.module.js
 *
 * Records training sessions from a bike and a heart-rate monitor, computes total and per-lap
 * statistics, and exports to TCX (Strava, Garmin Connect, TrainingPeaks …), the compact RIDE
 * binary format (database storage), base64 text (copy/paste between apps) and JSON.
 *
 * No UI and no dependencies. Works with the devices from ble_devices.module.js, but any object
 * with a `data` snapshot `{timestamp, ...}` (and optionally 'data' events) can be recorded.
 *
 * Units: time offsets `t` in ms since the session start, absolute times in ms since Unix epoch,
 * power W, cadence rpm, speed km/h, distance m, energy kJ, heart rate bpm, RR intervals ms.
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const SESSION_STATE = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    STOPPED: 'stopped',
});

export const SESSION_EVENT = Object.freeze({
    START: 'start',
    PAUSE: 'pause',
    RESUME: 'resume',
    LAP: 'lap',
    STOP: 'stop',
});

/** Bike sample channels, in the bit order used by the RIDE binary format. */
export const BIKE_CHANNELS = Object.freeze(['power', 'cadence', 'speed', 'distance', 'resistance']);

/** RIDE binary format constants (see docs/binary-format.md). */
export const RIDE_FORMAT = Object.freeze({
    MAGIC: 'RIDE',
    VERSION: 1,
    HEADER_SIZE: 24,
    FILE_EXTENSION: 'ride',
    MIME_TYPE: 'application/octet-stream',
});

const EVENT_CODES = Object.freeze({ start: 1, pause: 2, resume: 3, lap: 4, stop: 5 });
const EVENT_TYPES = Object.freeze(Object.fromEntries(Object.entries(EVENT_CODES).map(([k, v]) => [v, k])));
const TCX_HEART_RATE_MAX_AGE = 5000; // ms a heart-rate reading stays valid for a trackpoint

/** Thrown when binary/base64/JSON input is not a valid session. */
export class SessionFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SessionFormatError';
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const byTime = (a, b) => a.t - b.t;
const numberOrNull = (value) => (value == null || !Number.isFinite(+value) ? null : +value);
const overlap = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

function toTimeOffset(t) {
    const value = Math.round(+t);
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid time offset: ${t}`);
    return value;
}

function normalizeEvent(event) {
    if (!(event.type in EVENT_CODES)) throw new SessionFormatError(`Unknown session event type: ${event.type}`);
    return { t: toTimeOffset(event.t), type: event.type };
}

function normalizeBikeSample(sample) {
    const out = { t: toTimeOffset(sample.t) };
    for (const channel of BIKE_CHANNELS) out[channel] = numberOrNull(sample[channel]);
    return out;
}

function normalizeHeartRateSample(sample) {
    return {
        t: toTimeOffset(sample.t),
        heartRate: numberOrNull(sample.heartRate),
        rr: Array.isArray(sample.rr) ? sample.rr.map(Number).filter(Number.isFinite) : [],
    };
}

/** Appends keeping the array sorted by `t`. @returns {boolean} true when appended at the end */
function insertSorted(array, item) {
    if (!array.length || array[array.length - 1].t <= item.t) {
        array.push(item);
        return true;
    }
    let low = 0, high = array.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (array[mid].t <= item.t) low = mid + 1; else high = mid;
    }
    array.splice(low, 0, item);
    return false;
}

/** Format a duration in ms as `hh:mm:ss` (optionally `.mmm`). */
export function formatDuration(ms, { milliseconds = false } = {}) {
    if (ms == null || !Number.isFinite(ms)) return milliseconds ? '--:--:--.---' : '--:--:--';
    const sign = ms < 0 ? '-' : '';
    const abs = Math.abs(ms);
    const pad = (n) => String(n).padStart(2, '0');
    let text = `${sign}${pad(Math.floor(abs / 3600000))}:${pad(Math.floor(abs / 60000) % 60)}:${pad(Math.floor(abs / 1000) % 60)}`;
    if (milliseconds) text += `.${String(Math.floor(abs % 1000)).padStart(3, '0')}`;
    return text;
}

/** Trigger a file download in the browser. */
export function downloadFile(content, filename, mimeType = 'application/octet-stream') {
    if (typeof document === 'undefined') throw new Error('downloadFile() requires a browser document');
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function defaultFileName(session, extension) {
    const date = new Date(session.startTime ?? Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
    return `${stamp}_ride.${extension}`;
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

/** Time-weighted running statistics of one metric. */
class Channel {
    sum = 0;
    weight = 0;
    plainSum = 0;
    count = 0;
    max = null;
    min = null;

    add(value, weight, ignoreZero = false) {
        if (value == null) return;
        if (this.max == null || value > this.max) this.max = value;
        if (this.min == null || value < this.min) this.min = value;
        if (ignoreZero && value === 0) return;
        this.sum += value * weight;
        this.weight += weight;
        this.plainSum += value;
        this.count++;
    }

    summary() {
        const avg = this.weight > 0 ? this.sum / this.weight : this.count ? this.plainSum / this.count : null;
        return { avg, max: this.max, min: this.min };
    }
}

/**
 * Accumulates the statistics of one period (the whole session or one lap). Each sample is
 * weighted by the time since the previous sample of the same stream (capped at maxSampleGap),
 * because BLE sensors report the average over the interval leading up to the notification.
 */
class StatsAccumulator {
    constructor(distanceStart) {
        this.distanceStart = distanceStart;
        this.distanceEnd = null;
        this.bikeRef = null;
        this.heartRateRef = null;
        this.power = new Channel();
        this.cadence = new Channel();
        this.speed = new Channel();
        this.heartRate = new Channel();
        this.energy = 0; // J
        this.bikeCount = 0;
        this.heartRateCount = 0;
    }

    resume(t) {
        this.bikeRef = t;
        this.heartRateRef = t;
    }

    pause() {
        this.bikeRef = null;
        this.heartRateRef = null;
    }

    addBike(sample, maxGap) {
        const weight = this.bikeRef == null ? 0 : clamp(sample.t - this.bikeRef, 0, maxGap);
        this.bikeRef = sample.t;
        this.bikeCount++;
        this.power.add(sample.power, weight);
        this.cadence.add(sample.cadence, weight, true);
        this.speed.add(sample.speed, weight);
        if (sample.power != null) this.energy += Math.max(0, sample.power) * weight / 1000;
        if (sample.distance != null) this.distanceEnd = sample.distance;
    }

    addHeartRate(sample, maxGap) {
        const weight = this.heartRateRef == null ? 0 : clamp(sample.t - this.heartRateRef, 0, maxGap);
        this.heartRateRef = sample.t;
        this.heartRateCount++;
        this.heartRate.add(sample.heartRate > 0 ? sample.heartRate : null, weight);
    }

    get distance() {
        return this.distanceEnd == null ? 0 : Math.max(0, this.distanceEnd - this.distanceStart);
    }
}

/**
 * @typedef {object} MetricStats
 * @property {number|null} avg time-weighted average (cadence average ignores zeros)
 * @property {number|null} max
 * @property {number|null} min
 */

/**
 * @typedef {object} PeriodStats
 * @property {number|null} lap         lap index, null for the total
 * @property {number|null} startTime   ms since epoch
 * @property {number|null} endTime     ms since epoch, null while the period is still open
 * @property {number} elapsedTime      ms wall-clock time including pauses
 * @property {number} activeTime       ms excluding pauses
 * @property {number} distance         m
 * @property {number} energy           kJ mechanical work
 * @property {number} calories         kcal estimated burned (energy / 4.184 / grossEfficiency)
 * @property {MetricStats} power
 * @property {MetricStats} cadence
 * @property {MetricStats} speed
 * @property {MetricStats} heartRate
 * @property {{bike: number, heartRate: number}} samples
 */

// ---------------------------------------------------------------------------------------------
// Session (data model)
// ---------------------------------------------------------------------------------------------

/**
 * A recorded (or recording) training session. Pure data: it can be driven by a SessionTracker,
 * loaded from binary/base64/JSON, edited and exported.
 *
 * Data layout:
 *   startTime, endTime         ms since epoch (null when not started / not stopped)
 *   events                     [{t, type}]  type: 'start' | 'pause' | 'resume' | 'lap' | 'stop'
 *   bikeSamples                [{t, power, cadence, speed, distance, resistance}]  distance = m since start
 *   heartRateSamples           [{t, heartRate, rr}]   rr = RR intervals in ms
 *   meta                       free-form JSON object (title, notes, devices, …)
 * `t` is ms since startTime. Missing values are null. Heart rate is kept as its own time series
 * and only matched against bike samples when exporting (TCX).
 *
 * If you modify the arrays directly, call invalidate() so statistics are recomputed.
 */
export class Session {
    /** Gaps (ms) between samples longer than this are treated as sensor dropouts. */
    static maxSampleGap = 5000;
    /** Gross efficiency used to estimate burned calories from mechanical work. */
    static grossEfficiency = 0.24;

    #cache = null;

    /**
     * @param {object} [init]
     * @param {number|null} [init.startTime]
     * @param {number|null} [init.endTime]
     * @param {{t: number, type: string}[]} [init.events]
     * @param {object[]} [init.bikeSamples]
     * @param {object[]} [init.heartRateSamples]
     * @param {object} [init.meta]
     */
    constructor({ startTime = null, endTime = null, events = [], bikeSamples = [], heartRateSamples = [], meta = {} } = {}) {
        this.startTime = numberOrNull(startTime);
        this.endTime = numberOrNull(endTime);
        this.events = events.map(normalizeEvent).sort(byTime);
        this.bikeSamples = bikeSamples.map(normalizeBikeSample).sort(byTime);
        this.heartRateSamples = heartRateSamples.map(normalizeHeartRateSample).sort(byTime);
        this.meta = meta && typeof meta === 'object' ? JSON.parse(JSON.stringify(meta)) : {};
    }

    // --- State ----------------------------------------------------------------------------------

    /** @returns {'idle'|'running'|'paused'|'stopped'} */
    get state() {
        let state = SESSION_STATE.IDLE;
        for (const { type } of this.events) {
            if (type === 'start' || type === 'resume') state = SESSION_STATE.RUNNING;
            else if (type === 'pause') state = SESSION_STATE.PAUSED;
            else if (type === 'stop') state = SESSION_STATE.STOPPED;
        }
        return state;
    }

    get isRunning() { return this.state === SESSION_STATE.RUNNING; }
    get isPaused() { return this.state === SESSION_STATE.PAUSED; }
    get isStopped() { return this.state === SESSION_STATE.STOPPED; }

    /** Elapsed ms from start to stop (or to now while not stopped). */
    get duration() {
        return this.startTime == null ? 0 : this.#endOffset(Date.now());
    }

    /** Lap boundaries: `[{index, start, end}]` in ms offsets; `end` is null for an open lap. */
    get laps() {
        if (this.startTime == null) return [];
        const startEvent = this.events.find((e) => e.type === 'start');
        const starts = [startEvent ? startEvent.t : 0, ...this.events.filter((e) => e.type === 'lap').map((e) => e.t)];
        const stop = this.events.find((e) => e.type === 'stop');
        return starts.map((start, index) => ({
            index,
            start,
            end: index + 1 < starts.length ? starts[index + 1] : (stop ? stop.t : null),
        }));
    }

    // --- Recording ------------------------------------------------------------------------------

    start(time = Date.now()) {
        if (this.state !== SESSION_STATE.IDLE) throw new Error(`Cannot start a session that is ${this.state}`);
        this.startTime = time;
        this.endTime = null;
        this.#addEvent('start', 0);
    }

    pause(time = Date.now()) {
        this.#expectState([SESSION_STATE.RUNNING], 'pause');
        this.#addEvent('pause', this.#offsetOf(time));
    }

    resume(time = Date.now()) {
        this.#expectState([SESSION_STATE.PAUSED], 'resume');
        this.#addEvent('resume', this.#offsetOf(time));
    }

    /** Start a new lap. @returns {number} index of the new lap */
    lap(time = Date.now()) {
        this.#expectState([SESSION_STATE.RUNNING, SESSION_STATE.PAUSED], 'lap');
        this.#addEvent('lap', this.#offsetOf(time));
        return this.laps.length - 1;
    }

    stop(time = Date.now()) {
        this.#expectState([SESSION_STATE.RUNNING, SESSION_STATE.PAUSED], 'stop');
        const t = this.#offsetOf(time);
        this.#addEvent('stop', t);
        this.endTime = this.startTime + t;
    }

    /** Add a bike sample `{t, power, cadence, speed, distance, resistance}`. @returns the stored sample */
    addBikeSample(sample) {
        const stored = normalizeBikeSample(sample);
        this.#insert(this.bikeSamples, stored);
        return stored;
    }

    /** Add a heart-rate sample `{t, heartRate, rr}`. @returns the stored sample */
    addHeartRateSample(sample) {
        const stored = normalizeHeartRateSample(sample);
        this.#insert(this.heartRateSamples, stored);
        return stored;
    }

    // --- Statistics -----------------------------------------------------------------------------

    /**
     * Statistics for the whole session, the current (last) lap or a lap by index.
     * @param {'total'|'lap'|number} [range='total']
     * @param {number} [now=Date.now()] used for periods that are still open
     * @returns {PeriodStats}
     */
    getStats(range = 'total', now = Date.now()) {
        if (this.startTime == null) return emptyStats(range === 'total' ? null : 0);
        const cache = this.#ensureCache();
        const endOffset = this.#endOffset(now);
        if (range === 'total') {
            return this.#buildStats(cache.total, null, 0, endOffset, this.endTime != null, endOffset);
        }
        const laps = this.laps;
        const index = range === 'lap' ? laps.length - 1 : range;
        if (!Number.isInteger(index) || index < 0 || index >= laps.length) {
            throw new RangeError(`Lap ${range} does not exist (the session has ${laps.length} laps)`);
        }
        const lap = laps[index];
        const accumulator = cache.laps[index] ?? new StatsAccumulator(0);
        return this.#buildStats(accumulator, index, lap.start, lap.end ?? endOffset, lap.end != null, endOffset);
    }

    /** @returns {PeriodStats[]} statistics for every lap */
    getLapStats(now = Date.now()) {
        return this.laps.map((lap) => this.getStats(lap.index, now));
    }

    /** Forget cached statistics. Call after editing the sample/event arrays directly. */
    invalidate() {
        this.#cache = null;
    }

    // --- Editing --------------------------------------------------------------------------------

    /** Insert a lap marker at offset `t` (ms). @returns {number} index of the lap starting at `t` */
    insertLap(t) {
        if (this.startTime == null) throw new Error('The session has not been started');
        const offset = toTimeOffset(t);
        if (offset <= 0 || offset >= this.#endOffset(Date.now())) throw new RangeError('The lap must lie inside the session');
        insertSorted(this.events, { t: offset, type: 'lap' });
        this.invalidate();
        return this.laps.findIndex((lap) => lap.start === offset);
    }

    /** Remove the lap marker that starts lap `index` (≥ 1), merging it into the previous lap. */
    removeLap(index) {
        const lapEvents = this.events.filter((e) => e.type === 'lap');
        if (!Number.isInteger(index) || index < 1 || index > lapEvents.length) {
            throw new RangeError(`Lap ${index} cannot be removed (valid: 1 – ${lapEvents.length})`);
        }
        this.events.splice(this.events.indexOf(lapEvents[index - 1]), 1);
        this.invalidate();
    }

    /**
     * Keep only the part between `from` and `to` (ms offsets) of a stopped session. Times are
     * re-based so the cropped session starts at 0 and distances start at 0.
     */
    crop(from = 0, to = this.duration) {
        if (!this.isStopped) throw new Error('Only stopped sessions can be cropped');
        const start = Math.max(0, Math.round(from));
        const end = Math.min(this.duration, Math.round(to));
        if (end <= start) throw new RangeError('Crop range is empty');

        let pausedAtStart = false;
        let baseDistance = 0;
        for (const e of this.events) {
            if (e.t > start) break;
            if (e.type === 'pause') pausedAtStart = true;
            if (e.type === 'start' || e.type === 'resume') pausedAtStart = false;
        }
        for (const s of this.bikeSamples) {
            if (s.t > start) break;
            if (s.distance != null) baseDistance = s.distance;
        }

        const events = [{ t: 0, type: 'start' }];
        if (pausedAtStart) events.push({ t: 0, type: 'pause' });
        for (const e of this.events) {
            if (e.t > start && e.t < end && e.type !== 'start' && e.type !== 'stop') events.push({ t: e.t - start, type: e.type });
        }
        events.push({ t: end - start, type: 'stop' });

        const inRange = (s) => s.t >= start && s.t <= end;
        this.bikeSamples = this.bikeSamples.filter(inRange).map((s) => ({
            ...s,
            t: s.t - start,
            distance: s.distance == null ? null : Math.max(0, s.distance - baseDistance),
        }));
        this.heartRateSamples = this.heartRateSamples.filter(inRange).map((s) => ({ ...s, t: s.t - start }));
        this.events = events;
        this.startTime += start;
        this.endTime = this.startTime + (end - start);
        this.invalidate();
        return this;
    }

    /** Deep copy. */
    clone() {
        return Session.fromJSON(this.toJSON());
    }

    // --- Serialisation --------------------------------------------------------------------------

    /** Encode as RIDE binary (see docs/binary-format.md). @returns {Uint8Array} */
    toBinary() {
        return encodeSession(this);
    }

    /** RIDE binary encoded as base64 text – easy to copy/paste between applications. */
    toBase64() {
        return bytesToBase64(encodeSession(this));
    }

    /** Plain JSON-compatible object (also used by JSON.stringify). */
    toJSON() {
        return {
            format: 'ride-session',
            version: RIDE_FORMAT.VERSION,
            startTime: this.startTime,
            endTime: this.endTime,
            meta: this.meta,
            events: this.events,
            bikeSamples: this.bikeSamples,
            heartRateSamples: this.heartRateSamples,
        };
    }

    /** Garmin Training Center XML (TCX) – importable by Strava, Garmin Connect, TrainingPeaks … */
    toTCX(options) {
        return sessionToTCX(this, options);
    }

    downloadTCX(filename = defaultFileName(this, 'tcx')) {
        downloadFile(this.toTCX(), filename, 'application/vnd.garmin.tcx+xml');
    }

    downloadBinary(filename = defaultFileName(this, RIDE_FORMAT.FILE_EXTENSION)) {
        downloadFile(this.toBinary(), filename, RIDE_FORMAT.MIME_TYPE);
    }

    /** @param {Uint8Array|ArrayBuffer|DataView} bytes @param {{verifyChecksum?: boolean}} [options] */
    static fromBinary(bytes, options) {
        return decodeSession(bytes, options);
    }

    static fromBase64(text, options) {
        return decodeSession(base64ToBytes(text), options);
    }

    /** @param {object|string} json output of toJSON() or JSON.stringify(session) */
    static fromJSON(json) {
        let data = json;
        if (typeof json === 'string') {
            try {
                data = JSON.parse(json);
            } catch (error) {
                throw new SessionFormatError(`Invalid session JSON: ${error.message}`);
            }
        }
        if (!data || typeof data !== 'object') throw new SessionFormatError('Session JSON must be an object');
        return new Session(data);
    }

    /** Parse pasted text: JSON or base64 RIDE data. */
    static parse(text) {
        const trimmed = String(text).trim();
        return trimmed.startsWith('{') ? Session.fromJSON(trimmed) : Session.fromBase64(trimmed);
    }

    /** Load a File/Blob containing RIDE binary, base64 text or JSON. */
    static async fromFile(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (hasRideMagic(bytes)) return Session.fromBinary(bytes);
        return Session.parse(new TextDecoder().decode(bytes));
    }

    // --- Internals ------------------------------------------------------------------------------

    #expectState(allowed, action) {
        const state = this.state;
        if (!allowed.includes(state)) throw new Error(`Cannot ${action} a session that is ${state}`);
    }

    #offsetOf(time) {
        const last = this.events.length ? this.events[this.events.length - 1].t : 0;
        return Math.max(last, Math.round(time - this.startTime));
    }

    #endOffset(now) {
        if (this.endTime != null) return this.endTime - this.startTime;
        const lastEvent = this.events.length ? this.events[this.events.length - 1].t : 0;
        return Math.max(0, lastEvent, Math.round(now - this.startTime));
    }

    #addEvent(type, t) {
        this.#insert(this.events, { t, type });
    }

    #insert(array, item) {
        const appended = insertSorted(array, item);
        if (this.#cache && (!appended || item.t < this.#cache.lastT)) this.#cache = null;
    }

    #activeTime(from, to, endOffset) {
        let total = 0;
        let since = null;
        for (const { t, type } of this.events) {
            if (type === 'start' || type === 'resume') {
                since ??= t;
            } else if ((type === 'pause' || type === 'stop') && since != null) {
                total += overlap(since, t, from, to);
                since = null;
            }
        }
        if (since != null) total += overlap(since, endOffset, from, to);
        return total;
    }

    #buildStats(acc, lap, from, to, closed, endOffset) {
        const energy = acc.energy / 1000;
        return {
            lap,
            startTime: this.startTime + from,
            endTime: closed ? this.startTime + to : null,
            elapsedTime: to - from,
            activeTime: this.#activeTime(from, to, endOffset),
            distance: acc.distance,
            energy,
            calories: energy / 4.184 / Session.grossEfficiency,
            power: acc.power.summary(),
            cadence: acc.cadence.summary(),
            speed: acc.speed.summary(),
            heartRate: acc.heartRate.summary(),
            samples: { bike: acc.bikeCount, heartRate: acc.heartRateCount },
        };
    }

    /** Statistics are accumulated incrementally; only new samples are processed on each call. */
    #ensureCache() {
        this.#cache ??= {
            position: { events: 0, bike: 0, heartRate: 0 },
            lastT: -Infinity,
            running: false,
            lastDistance: 0,
            total: new StatsAccumulator(0),
            laps: [],
        };
        const cache = this.#cache;
        const { events, bikeSamples, heartRateSamples } = this;
        const position = cache.position;
        const maxGap = Session.maxSampleGap;

        for (;;) {
            const tEvent = position.events < events.length ? events[position.events].t : Infinity;
            const tBike = position.bike < bikeSamples.length ? bikeSamples[position.bike].t : Infinity;
            const tHeart = position.heartRate < heartRateSamples.length ? heartRateSamples[position.heartRate].t : Infinity;
            const t = Math.min(tEvent, tBike, tHeart);
            if (t === Infinity) break;
            cache.lastT = t;

            // At equal times samples go first: a sample describes the interval *before* it, so it
            // belongs to the period that a pause/stop/lap at the same instant closes.
            if (tBike === t) {
                const sample = bikeSamples[position.bike++];
                if (!cache.running) continue;
                cache.total.addBike(sample, maxGap);
                cache.laps[cache.laps.length - 1].addBike(sample, maxGap);
                if (sample.distance != null) cache.lastDistance = sample.distance;
            } else if (tHeart === t) {
                const sample = heartRateSamples[position.heartRate++];
                if (!cache.running) continue;
                cache.total.addHeartRate(sample, maxGap);
                cache.laps[cache.laps.length - 1].addHeartRate(sample, maxGap);
            } else {
                const { type } = events[position.events++];
                const currentLap = cache.laps[cache.laps.length - 1];
                if (type === 'start' || type === 'resume') {
                    if (!cache.laps.length) cache.laps.push(new StatsAccumulator(cache.lastDistance));
                    cache.running = true;
                    cache.total.resume(t);
                    cache.laps[cache.laps.length - 1].resume(t);
                } else if (type === 'pause' || type === 'stop') {
                    cache.running = false;
                    cache.total.pause();
                    currentLap?.pause();
                } else if (type === 'lap') {
                    currentLap?.pause();
                    const lap = new StatsAccumulator(cache.lastDistance);
                    if (cache.running) lap.resume(t);
                    cache.laps.push(lap);
                }
            }
        }
        return cache;
    }
}

function emptyStats(lap) {
    const metric = () => ({ avg: null, max: null, min: null });
    return {
        lap, startTime: null, endTime: null, elapsedTime: 0, activeTime: 0, distance: 0, energy: 0, calories: 0,
        power: metric(), cadence: metric(), speed: metric(), heartRate: metric(), samples: { bike: 0, heartRate: 0 },
    };
}

// ---------------------------------------------------------------------------------------------
// Session tracker (live recording)
// ---------------------------------------------------------------------------------------------

/**
 * Records a Session live from a bike and/or heart-rate monitor.
 *
 * Every data notification is recorded: the tracker listens to the devices' 'data' events, and as
 * a fallback polls `device.data` every `pollInterval` ms and records it when its timestamp has
 * changed. Bike and heart-rate data are stored as two independent time series.
 *
 * Events (`tracker.on(type, fn)`, payload = event.detail):
 *   'start', 'pause', 'resume', 'stop', 'lap' {lap}, 'reset' {previous}, 'statechange' {state},
 *   'sample' {kind: 'bike'|'heartRate', sample}
 */
export class SessionTracker extends EventTarget {
    #session;
    #bike = null;
    #heartRateMonitor = null;
    #unsubscribe = { bike: null, heartRate: null };
    #lastTimestamp = { bike: null, heartRate: null };
    #bikeDistanceRef = null;
    #distance = 0;
    #activeSince = null;
    #pollTimer = null;

    /**
     * @param {object} [options]
     * @param {object} [options.bike] BluetoothBike, SimulatedBike or any `{data: {timestamp, ...}}`
     * @param {object} [options.heartRateMonitor] HeartRateMonitor, SimulatedHeartRateMonitor or compatible
     * @param {number} [options.pollInterval=500] ms between fallback polls of the devices
     */
    constructor({ bike = null, heartRateMonitor = null, pollInterval = 500 } = {}) {
        super();
        this.pollInterval = pollInterval;
        this.#session = new Session();
        this.attachBike(bike);
        this.attachHeartRateMonitor(heartRateMonitor);
    }

    /** The session being recorded. */
    get session() { return this.#session; }
    get state() { return this.#session.state; }
    get isRunning() { return this.#session.isRunning; }
    get isPaused() { return this.#session.isPaused; }
    get isStopped() { return this.#session.isStopped; }
    get bike() { return this.#bike; }
    get heartRateMonitor() { return this.#heartRateMonitor; }

    /** Latest live values from the attached devices (not only while recording). */
    get current() {
        const bike = this.#bike?.data;
        const heart = this.#heartRateMonitor?.data;
        return {
            power: bike?.power ?? null,
            cadence: bike?.cadence ?? null,
            speed: bike?.speed ?? null,
            resistance: bike?.resistance ?? null,
            heartRate: heart?.heartRate ?? bike?.heartRate ?? null,
        };
    }

    /** Attach (or replace, or detach with null) the bike. Can be done at any time. */
    attachBike(bike) {
        this.#unsubscribe.bike?.();
        this.#bike = bike;
        this.#lastTimestamp.bike = bike?.data?.timestamp ?? null;
        this.#bikeDistanceRef = bike?.data?.distance ?? null;
        this.#unsubscribe.bike = this.#listen(bike, 'bike');
        this.#updateDeviceMeta();
    }

    /** Attach (or replace, or detach with null) the heart-rate monitor. */
    attachHeartRateMonitor(heartRateMonitor) {
        this.#unsubscribe.heartRate?.();
        this.#heartRateMonitor = heartRateMonitor;
        this.#lastTimestamp.heartRate = heartRateMonitor?.data?.timestamp ?? null;
        this.#unsubscribe.heartRate = this.#listen(heartRateMonitor, 'heartRate');
        this.#updateDeviceMeta();
    }

    start() {
        const now = Date.now();
        this.#session.start(now);
        this.#activeSince = now;
        this.#distance = 0;
        this.#bikeDistanceRef = this.#bike?.data?.distance ?? null;
        this.#updateDeviceMeta();
        clearInterval(this.#pollTimer);
        this.#pollTimer = setInterval(() => this.#poll(), this.pollInterval);
        this.#notify('start');
    }

    pause() {
        this.#poll();
        this.#session.pause(Date.now());
        this.#notify('pause');
    }

    resume() {
        const now = Date.now();
        this.#session.resume(now);
        this.#activeSince = now;
        this.#notify('resume');
    }

    /** Pause when running, resume when paused. */
    togglePause() {
        if (this.isPaused) this.resume(); else this.pause();
    }

    /** Set a lap flag. @returns {number} index of the new lap */
    lap() {
        this.#poll();
        const lap = this.#session.lap(Date.now());
        this._emit('lap', { lap });
        return lap;
    }

    stop() {
        this.#poll();
        this.#session.stop(Date.now());
        clearInterval(this.#pollTimer);
        this.#pollTimer = null;
        this.#notify('stop');
    }

    /** Discard the current session and prepare a new one. @returns {Session} the previous session */
    reset() {
        clearInterval(this.#pollTimer);
        this.#pollTimer = null;
        const previous = this.#session;
        this.#session = new Session();
        this.#distance = 0;
        this.#activeSince = null;
        this.#updateDeviceMeta();
        this._emit('reset', { previous });
        this._emit('statechange', { state: this.state });
        return previous;
    }

    /** Stop timers and listeners. The tracker cannot record afterwards. */
    destroy() {
        clearInterval(this.#pollTimer);
        this.#pollTimer = null;
        this.#unsubscribe.bike?.();
        this.#unsubscribe.heartRate?.();
    }

    /** @param {'total'|'lap'|number} [range='total'] @returns {PeriodStats} */
    getStats(range = 'total') {
        return this.#session.getStats(range, Date.now());
    }

    /** @returns {PeriodStats[]} */
    getLapStats() {
        return this.#session.getLapStats(Date.now());
    }

    toTCX(options) { return this.#session.toTCX(options); }
    toBinary() { return this.#session.toBinary(); }
    toBase64() { return this.#session.toBase64(); }
    downloadTCX(filename) { this.#session.downloadTCX(filename); }
    downloadBinary(filename) { this.#session.downloadBinary(filename); }

    /** Subscribe to an event; returns an unsubscribe function. */
    on(type, listener) {
        const handler = (event) => listener(event.detail, event);
        this.addEventListener(type, handler);
        return () => this.removeEventListener(type, handler);
    }

    /** @protected */
    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    #notify(type) {
        this._emit(type, { state: this.state });
        this._emit('statechange', { state: this.state });
    }

    #listen(source, kind) {
        if (!source || typeof source.addEventListener !== 'function') return null;
        const handler = (event) => this.#record(kind, event?.detail?.timestamp != null ? event.detail : source.data);
        source.addEventListener('data', handler);
        return () => source.removeEventListener('data', handler);
    }

    #poll() {
        this.#record('bike', this.#bike?.data);
        this.#record('heartRate', this.#heartRateMonitor?.data);
    }

    #record(kind, data) {
        if (!data || data.timestamp == null) return;
        const last = this.#lastTimestamp[kind];
        if (last != null && data.timestamp <= last) return;
        this.#lastTimestamp[kind] = data.timestamp;
        if (kind === 'bike') this.#recordBike(data); else this.#recordHeartRate(data);
    }

    #accepts(timestamp) {
        return this.#session.state === SESSION_STATE.RUNNING && timestamp >= this.#activeSince;
    }

    #recordBike(data) {
        // Distance is tracked relative to the session so device resets/reconnects do not cause jumps.
        let delta = 0;
        if (data.distance != null) {
            if (this.#bikeDistanceRef != null) {
                const d = data.distance - this.#bikeDistanceRef;
                if (d >= 0 && d < 1000) delta = d;
            }
            this.#bikeDistanceRef = data.distance;
        }
        if (!this.#accepts(data.timestamp)) return;
        this.#distance += delta;
        const sample = this.#session.addBikeSample({
            t: data.timestamp - this.#session.startTime,
            power: data.power,
            cadence: data.cadence,
            speed: data.speed,
            distance: this.#distance,
            resistance: data.resistance,
        });
        this._emit('sample', { kind: 'bike', sample });
    }

    #recordHeartRate(data) {
        if (data.heartRate == null || !this.#accepts(data.timestamp)) return;
        const sample = this.#session.addHeartRateSample({
            t: data.timestamp - this.#session.startTime,
            heartRate: data.heartRate,
            rr: data.rrIntervals ?? [],
        });
        this._emit('sample', { kind: 'heartRate', sample });
    }

    #updateDeviceMeta() {
        if (!this.#session || this.#session.isStopped) return;
        const devices = {};
        if (this.#bike) devices.bike = { name: this.#bike.name ?? null };
        if (this.#heartRateMonitor) devices.heartRateMonitor = { name: this.#heartRateMonitor.name ?? null };
        this.#session.meta.devices = devices;
    }
}

// ---------------------------------------------------------------------------------------------
// TCX export
// ---------------------------------------------------------------------------------------------

const escapeXml = (text) => String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/**
 * Build a TCX document. Trackpoints are the bike samples; each carries the most recent heart rate
 * (at most 5 s old). Sessions without bike data use the heart-rate samples as trackpoints.
 * @param {Session} session
 * @param {{now?: number}} [options] `now` closes an unfinished session (default Date.now())
 * @returns {string}
 */
export function sessionToTCX(session, { now = Date.now() } = {}) {
    if (session.startTime == null) throw new Error('The session has not been started');
    const iso = (offset) => new Date(session.startTime + offset).toISOString();
    const bike = session.bikeSamples;
    const hearts = session.heartRateSamples;
    const useBike = bike.length > 0;
    const points = useBike ? bike : hearts;

    let heartIndex = -1;
    const heartRateAt = (t) => {
        while (heartIndex + 1 < hearts.length && hearts[heartIndex + 1].t <= t) heartIndex++;
        const sample = hearts[heartIndex];
        return sample && t - sample.t <= TCX_HEART_RATE_MAX_AGE && sample.heartRate > 0 ? sample.heartRate : null;
    };

    const trackpoint = (s) => {
        let xml = `<Trackpoint><Time>${iso(s.t)}</Time>`;
        if (useBike && s.distance != null) xml += `<DistanceMeters>${s.distance.toFixed(2)}</DistanceMeters>`;
        const heartRate = heartRateAt(s.t);
        if (heartRate != null) xml += `<HeartRateBpm><Value>${clamp(Math.round(heartRate), 1, 255)}</Value></HeartRateBpm>`;
        if (useBike && s.cadence != null) xml += `<Cadence>${clamp(Math.round(s.cadence), 0, 254)}</Cadence>`;
        let extension = '';
        if (useBike && s.speed != null) extension += `<ns3:Speed>${(s.speed / 3.6).toFixed(3)}</ns3:Speed>`;
        if (useBike && s.power != null) extension += `<ns3:Watts>${Math.max(0, Math.round(s.power))}</ns3:Watts>`;
        if (extension) xml += `<Extensions><ns3:TPX>${extension}</ns3:TPX></Extensions>`;
        return `${xml}</Trackpoint>`;
    };

    const out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" '
        + 'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" '
        + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        + 'xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">',
        '  <Activities>',
        '    <Activity Sport="Biking">',
        `      <Id>${iso(0)}</Id>`,
    ];

    const laps = session.laps;
    let pointIndex = 0;
    laps.forEach((lap, i) => {
        const stats = session.getStats(i, now);
        const isLast = i === laps.length - 1;
        out.push(`      <Lap StartTime="${iso(lap.start)}">`);
        out.push(`        <TotalTimeSeconds>${(stats.activeTime / 1000).toFixed(1)}</TotalTimeSeconds>`);
        out.push(`        <DistanceMeters>${stats.distance.toFixed(2)}</DistanceMeters>`);
        if (stats.speed.max != null) out.push(`        <MaximumSpeed>${(stats.speed.max / 3.6).toFixed(3)}</MaximumSpeed>`);
        out.push(`        <Calories>${clamp(Math.round(stats.calories), 0, 65535)}</Calories>`);
        if (stats.heartRate.avg != null) out.push(`        <AverageHeartRateBpm><Value>${clamp(Math.round(stats.heartRate.avg), 1, 255)}</Value></AverageHeartRateBpm>`);
        if (stats.heartRate.max != null) out.push(`        <MaximumHeartRateBpm><Value>${clamp(Math.round(stats.heartRate.max), 1, 255)}</Value></MaximumHeartRateBpm>`);
        out.push('        <Intensity>Active</Intensity>');
        if (stats.cadence.avg != null) out.push(`        <Cadence>${clamp(Math.round(stats.cadence.avg), 0, 254)}</Cadence>`);
        out.push('        <TriggerMethod>Manual</TriggerMethod>');

        const track = [];
        while (pointIndex < points.length && (isLast || points[pointIndex].t <= lap.end)) {
            track.push(`          ${trackpoint(points[pointIndex++])}`);
        }
        if (track.length) out.push('        <Track>', ...track, '        </Track>');

        let lapExtension = '';
        if (stats.speed.avg != null) lapExtension += `<ns3:AvgSpeed>${(stats.speed.avg / 3.6).toFixed(3)}</ns3:AvgSpeed>`;
        if (stats.power.avg != null) lapExtension += `<ns3:AvgWatts>${Math.round(stats.power.avg)}</ns3:AvgWatts>`;
        if (stats.power.max != null) lapExtension += `<ns3:MaxWatts>${Math.round(stats.power.max)}</ns3:MaxWatts>`;
        if (lapExtension) out.push(`        <Extensions><ns3:LX>${lapExtension}</ns3:LX></Extensions>`);
        out.push('      </Lap>');
    });

    const notes = [session.meta?.title, session.meta?.notes].filter(Boolean).join('\n');
    if (notes) out.push(`      <Notes>${escapeXml(notes)}</Notes>`);
    out.push('    </Activity>', '  </Activities>', '</TrainingCenterDatabase>', '');
    return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// RIDE binary format (specification: docs/binary-format.md)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 (IEEE 802.3, as used by zip/PNG). */
export function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

class ByteWriter {
    constructor(size) {
        this.bytes = new Uint8Array(size);
        this.view = new DataView(this.bytes.buffer);
        this.offset = 0;
    }
    u8(v) { this.view.setUint8(this.offset, v); this.offset += 1; }
    u16(v) { this.view.setUint16(this.offset, v, true); this.offset += 2; }
    u32(v) { this.view.setUint32(this.offset, v, true); this.offset += 4; }
    f32(v) { this.view.setFloat32(this.offset, v, true); this.offset += 4; }
    f64(v) { this.view.setFloat64(this.offset, v, true); this.offset += 8; }
    ascii(text) { for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i)); }
    raw(bytes) { this.bytes.set(bytes, this.offset); this.offset += bytes.length; }
    chunk(id, length) { this.ascii(id); this.u32(length); }
}

class ChunkReader {
    constructor(view, start, end, id) {
        this.view = view;
        this.offset = start;
        this.end = end;
        this.id = id;
    }
    #take(size) {
        if (this.offset + size > this.end) throw new SessionFormatError(`Chunk ${this.id} is truncated`);
        const at = this.offset;
        this.offset += size;
        return at;
    }
    u8() { return this.view.getUint8(this.#take(1)); }
    u16() { return this.view.getUint16(this.#take(2), true); }
    u32() { return this.view.getUint32(this.#take(4), true); }
    f32() { return this.view.getFloat32(this.#take(4), true); }
}

const encodeTime = (t) => clamp(Math.round(t), 0, 0xFFFFFFFF);
const popCount = (mask) => { let n = 0; for (let m = mask >>> 0; m; m >>>= 1) n += m & 1; return n; };

function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('Expected a Uint8Array, ArrayBuffer or DataView');
}

function hasRideMagic(bytes) {
    return bytes.length >= 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === RIDE_FORMAT.MAGIC;
}

/**
 * Encode a session as RIDE binary.
 * @param {Session} session
 * @returns {Uint8Array}
 */
export function encodeSession(session) {
    const meta = new TextEncoder().encode(JSON.stringify(session.meta ?? {}));
    const events = session.events;
    const bike = session.bikeSamples;
    const hearts = session.heartRateSamples;

    let mask = 0;
    BIKE_CHANNELS.forEach((name, bit) => {
        if (bike.some((s) => s[name] != null)) mask |= 1 << bit;
    });
    const channels = BIKE_CHANNELS.filter((_, bit) => mask & (1 << bit));

    const eventsSize = 4 + events.length * 5;
    const bikeSize = 8 + bike.length * (4 + 4 * channels.length);
    let heartSize = 4;
    for (const s of hearts) heartSize += 7 + 2 * Math.min(s.rr.length, 255);
    const total = RIDE_FORMAT.HEADER_SIZE + (8 + meta.length) + (8 + eventsSize) + (8 + bikeSize) + (8 + heartSize) + 4;

    const w = new ByteWriter(total);
    w.ascii(RIDE_FORMAT.MAGIC);
    w.u16(RIDE_FORMAT.VERSION);
    w.u16(RIDE_FORMAT.HEADER_SIZE);
    w.f64(session.startTime ?? NaN);
    w.f64(session.endTime ?? NaN);

    w.chunk('META', meta.length);
    w.raw(meta);

    w.chunk('EVNT', eventsSize);
    w.u32(events.length);
    for (const e of events) {
        w.u32(encodeTime(e.t));
        w.u8(EVENT_CODES[e.type]);
    }

    w.chunk('BIKE', bikeSize);
    w.u32(bike.length);
    w.u32(mask);
    for (const s of bike) {
        w.u32(encodeTime(s.t));
        for (const name of channels) w.f32(s[name] ?? NaN);
    }

    w.chunk('HRTR', heartSize);
    w.u32(hearts.length);
    for (const s of hearts) {
        const rr = s.rr.slice(0, 255);
        w.u32(encodeTime(s.t));
        w.u16(s.heartRate == null ? 0 : clamp(Math.round(s.heartRate), 0, 0xFFFF));
        w.u8(rr.length);
        for (const ms of rr) w.u16(clamp(Math.round(ms * 1.024), 0, 0xFFFF)); // 1/1024 s
    }

    w.u32(crc32(w.bytes.subarray(0, w.offset)));
    return w.bytes;
}

/**
 * Decode RIDE binary into a Session.
 * @param {Uint8Array|ArrayBuffer|DataView} input
 * @param {{verifyChecksum?: boolean}} [options]
 * @returns {Session}
 */
export function decodeSession(input, { verifyChecksum = true } = {}) {
    const bytes = toBytes(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < RIDE_FORMAT.HEADER_SIZE + 4 || !hasRideMagic(bytes)) {
        throw new SessionFormatError('Not a RIDE session (missing "RIDE" signature)');
    }
    const version = view.getUint16(4, true);
    if (version < 1 || version > RIDE_FORMAT.VERSION) {
        throw new SessionFormatError(`Unsupported RIDE format version ${version} (this library reads up to ${RIDE_FORMAT.VERSION})`);
    }
    const headerSize = view.getUint16(6, true);
    const bodyEnd = bytes.length - 4;
    if (headerSize < RIDE_FORMAT.HEADER_SIZE || headerSize > bodyEnd) throw new SessionFormatError('Invalid header size');
    if (verifyChecksum) {
        const expected = view.getUint32(bodyEnd, true);
        const actual = crc32(bytes.subarray(0, bodyEnd));
        if (expected !== actual) throw new SessionFormatError('Checksum mismatch: the data is corrupted or incomplete');
    }

    const nanToNull = (v) => (Number.isNaN(v) ? null : v);
    const init = {
        startTime: nanToNull(view.getFloat64(8, true)),
        endTime: nanToNull(view.getFloat64(16, true)),
        meta: {},
        events: [],
        bikeSamples: [],
        heartRateSamples: [],
    };

    let offset = headerSize;
    while (offset < bodyEnd) {
        if (offset + 8 > bodyEnd) throw new SessionFormatError('Truncated chunk header');
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const length = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = start + length;
        if (end > bodyEnd) throw new SessionFormatError(`Chunk ${id} extends past the end of the data`);
        const r = new ChunkReader(view, start, end, id);

        switch (id) {
            case 'META': {
                try {
                    init.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)) || '{}');
                } catch {
                    throw new SessionFormatError('META chunk is not valid JSON');
                }
                break;
            }
            case 'EVNT': {
                const count = r.u32();
                for (let i = 0; i < count; i++) {
                    const t = r.u32();
                    const type = EVENT_TYPES[r.u8()];
                    if (type) init.events.push({ t, type });
                }
                break;
            }
            case 'BIKE': {
                const count = r.u32();
                const mask = r.u32();
                const channelCount = popCount(mask);
                for (let i = 0; i < count; i++) {
                    const sample = { t: r.u32() };
                    for (let bit = 0, read = 0; read < channelCount; bit++) {
                        if (!(mask & (2 ** bit))) continue;
                        const value = r.f32();
                        read++;
                        if (bit < BIKE_CHANNELS.length) sample[BIKE_CHANNELS[bit]] = Number.isNaN(value) ? null : value;
                    }
                    init.bikeSamples.push(sample);
                }
                break;
            }
            case 'HRTR': {
                const count = r.u32();
                for (let i = 0; i < count; i++) {
                    const t = r.u32();
                    const heartRate = r.u16();
                    const rrCount = r.u8();
                    const rr = [];
                    for (let k = 0; k < rrCount; k++) rr.push(r.u16() * 1000 / 1024);
                    init.heartRateSamples.push({ t, heartRate: heartRate || null, rr });
                }
                break;
            }
            default:
                break; // Unknown chunk from a newer writer: skip it.
        }
        offset = end;
    }
    return new Session(init);
}

/** Base64-encode bytes (chunked so large sessions do not overflow the call stack). */
export function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Decode base64 (standard or URL-safe, whitespace and `data:` prefix tolerated). */
export function base64ToBytes(text) {
    let clean = String(text).trim();
    if (clean.startsWith('data:')) clean = clean.slice(clean.indexOf(',') + 1);
    clean = clean.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    clean += '='.repeat((4 - (clean.length % 4)) % 4);
    let binary;
    try {
        binary = atob(clean);
    } catch {
        throw new SessionFormatError('The text is not valid base64');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
