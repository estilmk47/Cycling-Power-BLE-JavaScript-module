import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Session, SessionTracker, SessionFormatError, encodeSession, decodeSession, crc32, formatDuration,
} from '../src/session_tracker.module.js';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

/** 20 s session: 10 s at 200 W, lap, 10 s at 100 W; 1 Hz bike, heart rate every 2 s. */
function sampleSession() {
    const session = new Session({ meta: { title: 'Test ride' } });
    session.start(T0);
    for (let s = 1; s <= 20; s++) {
        if (s === 11) session.lap(T0 + 10000);
        session.addBikeSample({ t: s * 1000, power: s <= 10 ? 200 : 100, cadence: 90, speed: 36, distance: s * 10, resistance: null });
        if (s % 2 === 0) session.addHeartRateSample({ t: s * 1000, heartRate: s <= 10 ? 120 : 140, rr: [500] });
    }
    session.stop(T0 + 20000);
    return session;
}

test('total and lap statistics are time-weighted', () => {
    const session = sampleSession();
    const total = session.getStats();
    assert.equal(total.power.avg, 150);
    assert.equal(total.power.max, 200);
    assert.equal(total.energy, 3); // 200 W·10 s + 100 W·10 s = 3 kJ
    assert.equal(total.distance, 200);
    assert.equal(total.elapsedTime, 20000);
    assert.equal(total.activeTime, 20000);
    assert.equal(total.heartRate.avg, 130);
    assert.equal(total.endTime, T0 + 20000);

    const [lap0, lap1] = session.getLapStats();
    assert.equal(lap0.power.avg, 200);
    assert.equal(lap1.power.avg, 100);
    assert.equal(lap0.distance, 100);
    assert.equal(lap1.distance, 100);
    assert.equal(lap1.heartRate.max, 140);
    assert.deepEqual(session.getStats('lap'), lap1);
});

test('pauses are excluded from active time and averages', () => {
    const session = new Session();
    session.start(T0);
    session.addBikeSample({ t: 1000, power: 100 });
    session.addBikeSample({ t: 2000, power: 100 });
    session.pause(T0 + 2000);
    session.resume(T0 + 62000);
    session.addBikeSample({ t: 63000, power: 300 });
    session.stop(T0 + 63000);
    const stats = session.getStats();
    assert.equal(stats.elapsedTime, 63000);
    assert.equal(stats.activeTime, 3000);
    assert.equal(stats.power.avg, (100 + 100 + 300) / 3);
    assert.equal(session.state, 'stopped');
});

test('statistics update incrementally while recording', () => {
    const session = new Session();
    session.start(T0);
    session.addBikeSample({ t: 1000, power: 100 });
    assert.equal(session.getStats('total', T0 + 1000).power.avg, 100);
    session.addBikeSample({ t: 2000, power: 300 });
    assert.equal(session.getStats('total', T0 + 2000).power.avg, 200);
    assert.equal(session.getStats('total', T0 + 2000).endTime, null);
    session.lap(T0 + 2000);
    session.addBikeSample({ t: 3000, power: 50 });
    assert.equal(session.getStats('lap', T0 + 3000).power.avg, 50);
    assert.equal(session.getStats('total', T0 + 3000).power.avg, 150);
});

test('invalid state transitions throw', () => {
    const session = new Session();
    assert.throws(() => session.pause(), /Cannot pause/);
    session.start(T0);
    assert.throws(() => session.start(), /Cannot start/);
    session.stop(T0 + 1);
    assert.throws(() => session.lap(), /Cannot lap/);
});

test('binary round-trip preserves the session', () => {
    const session = sampleSession();
    const bytes = session.toBinary();
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIDE');
    const copy = Session.fromBinary(bytes);
    assert.equal(copy.startTime, session.startTime);
    assert.equal(copy.endTime, session.endTime);
    assert.deepEqual(copy.events, session.events);
    assert.deepEqual(copy.bikeSamples, session.bikeSamples);
    assert.deepEqual(copy.heartRateSamples, session.heartRateSamples);
    assert.deepEqual(copy.meta, session.meta);
    assert.deepEqual(copy.getStats(), session.getStats());
    assert.deepEqual(encodeSession(copy), bytes); // re-encoding is byte-identical
});

test('base64 and JSON round-trips', () => {
    const session = sampleSession();
    const fromText = Session.parse(`  ${session.toBase64()}\n`);
    assert.deepEqual(fromText.bikeSamples, session.bikeSamples);
    const fromJson = Session.parse(JSON.stringify(session));
    assert.deepEqual(fromJson.toJSON(), session.toJSON());
});

test('corrupted binary data is rejected by the checksum', () => {
    const bytes = sampleSession().toBinary();
    bytes[40] ^= 0xFF;
    assert.throws(() => decodeSession(bytes), SessionFormatError);
    assert.throws(() => Session.fromBase64('aGVsbG8='), /signature/);
    assert.throws(() => Session.fromBase64('***'), SessionFormatError);
});

test('unknown chunks and channels are skipped (forward compatibility)', () => {
    const original = sampleSession().toBinary();
    const body = original.subarray(0, original.length - 4);
    const extra = Uint8Array.from([...'XTRA'].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3]));
    const patched = new Uint8Array(body.length + extra.length + 4);
    patched.set(body);
    patched.set(extra, body.length);
    new DataView(patched.buffer).setUint32(patched.length - 4, crc32(patched.subarray(0, patched.length - 4)), true);
    const decoded = Session.fromBinary(patched);
    assert.equal(decoded.bikeSamples.length, 20);
});

test('TCX export contains laps, trackpoints, heart rate and power', () => {
    const tcx = sampleSession().toTCX();
    assert.match(tcx, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.equal((tcx.match(/<Lap /g) ?? []).length, 2);
    assert.equal((tcx.match(/<Trackpoint>/g) ?? []).length, 20);
    assert.match(tcx, /<Id>2026-01-01T10:00:00.000Z<\/Id>/);
    assert.match(tcx, /<HeartRateBpm><Value>120<\/Value><\/HeartRateBpm>/);
    assert.match(tcx, /<ns3:Watts>200<\/ns3:Watts>/);
    assert.match(tcx, /<TotalTimeSeconds>10.0<\/TotalTimeSeconds>/);
    assert.match(tcx, /<Notes>Test ride<\/Notes>/);
    assert.equal((tcx.match(/<Trackpoint>/g)).length, (tcx.match(/<\/Trackpoint>/g)).length);
});

test('editing: insertLap, removeLap and crop', () => {
    const session = sampleSession();
    assert.equal(session.insertLap(5000), 1);
    assert.equal(session.laps.length, 3);
    assert.equal(session.getStats(1).power.avg, 200);
    session.removeLap(1);
    assert.equal(session.laps.length, 2);
    assert.throws(() => session.removeLap(0), RangeError);

    session.crop(5000, 15000);
    assert.equal(session.startTime, T0 + 5000);
    assert.equal(session.duration, 10000);
    assert.equal(session.bikeSamples[0].t, 0);
    assert.equal(session.bikeSamples[0].distance, 0);
    const total = session.getStats();
    assert.equal(total.distance, 100);
    assert.equal(session.laps.length, 2);
});

test('SessionTracker records every notification, deduplicates polls and tracks distance', async () => {
    const source = new EventTarget();
    let data = { timestamp: null, power: null, distance: 500 };
    Object.defineProperty(source, 'data', { get: () => data });
    const emit = (values) => {
        data = { ...data, ...values };
        source.dispatchEvent(new CustomEvent('data', { detail: data }));
    };

    const tracker = new SessionTracker({ bike: source, pollInterval: 5 });
    tracker.start();
    const now = Date.now();
    emit({ timestamp: now + 1, power: 100, cadence: 80, speed: 30, distance: 510 });
    emit({ timestamp: now + 2, power: 120, distance: 520 });
    await new Promise((resolve) => setTimeout(resolve, 20)); // polls see the same timestamp: no duplicates
    assert.equal(tracker.session.bikeSamples.length, 2);
    assert.deepEqual(tracker.session.bikeSamples.map((s) => s.distance), [10, 20]);

    tracker.pause();
    emit({ timestamp: now + 3, power: 999, distance: 600 }); // ignored while paused
    tracker.resume();
    emit({ timestamp: Date.now() + 10, power: 140, distance: 610 });
    tracker.lap();
    tracker.stop();
    assert.deepEqual(tracker.session.bikeSamples.map((s) => s.power), [100, 120, 140]);
    assert.equal(tracker.session.bikeSamples.at(-1).distance, 30); // the paused 80 m are not counted
    assert.equal(tracker.state, 'stopped');
    assert.equal(tracker.getLapStats().length, 2);
    tracker.destroy();
});

test('SessionTracker records heart rate as its own series', () => {
    const hrm = new EventTarget();
    let data = { timestamp: null, heartRate: null, rrIntervals: [] };
    Object.defineProperty(hrm, 'data', { get: () => data });
    const tracker = new SessionTracker({ heartRateMonitor: hrm });
    tracker.start();
    data = { timestamp: Date.now() + 1, heartRate: 130, rrIntervals: [461.9140625] };
    hrm.dispatchEvent(new CustomEvent('data', { detail: data }));
    tracker.stop();
    assert.equal(tracker.session.heartRateSamples.length, 1);
    assert.deepEqual(tracker.session.heartRateSamples[0].rr, [461.9140625]);
    const copy = Session.fromBinary(tracker.toBinary());
    assert.deepEqual(copy.heartRateSamples[0].rr, [461.9140625]); // RR stored losslessly in 1/1024 s
    tracker.destroy();
});

test('formatDuration', () => {
    assert.equal(formatDuration(3723004), '01:02:03');
    assert.equal(formatDuration(3723004, { milliseconds: true }), '01:02:03.004');
    assert.equal(formatDuration(null), '--:--:--');
});
