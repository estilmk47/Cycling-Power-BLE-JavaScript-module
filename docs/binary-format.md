# RIDE binary session format – version 1

The RIDE format is the raw, lossless storage format of a `Session` from
[`session_tracker.module.js`](../src/session_tracker.module.js). It is designed to be

- **compact** – about 24 bytes per bike sample (≈ 170 kB for a 2-hour ride at 1 Hz),
- **complete** – every recorded data point, every pause/resume/lap event, RR intervals and free-form metadata,
- **safe to move around** – a CRC-32 checksum detects truncated or corrupted data (copy/paste, uploads, database round-trips),
- **easy to read in any language** – fixed-size little-endian fields, no compression, no dependencies,
- **forward compatible** – readers skip chunks and channels they do not know.

File extension: `.ride` · MIME type: `application/octet-stream` · Text form: standard base64 of the bytes.

> Looking for a practical introduction (exporting, pasting, editing, storing in a database) and a
> drag-and-drop inspector? Open the [user guide](binary-format-guide.html) in a browser.

---

## 1. Conventions

| Notation | Meaning |
| --- | --- |
| `u8`, `u16`, `u32` | unsigned integers of 1, 2, 4 bytes |
| `f32`, `f64` | IEEE 754 single / double precision floats |
| `char[4]` | four ASCII characters |

- **All multi-byte values are little-endian.**
- Offsets are in bytes from the start of the data.
- Time offsets `t` are `u32` **milliseconds since the session start time** (max ≈ 49.7 days).
- Absolute times are `f64` **milliseconds since the Unix epoch** (UTC), i.e. JavaScript `Date.now()`.

## 2. Layout

```
+---------------------------+  offset 0
| Header (24 bytes in v1)   |
+---------------------------+  offset = headerSize
| Chunk "META"              |
| Chunk "EVNT"              |
| Chunk "BIKE"              |
| Chunk "HRTR"              |
| … future chunks …         |
+---------------------------+  offset = length − 4
| CRC-32 (u32)              |
+---------------------------+
```

### 2.1 Header

| Offset | Type | Field | Description |
| ---: | --- | --- | --- |
| 0 | `char[4]` | magic | `"RIDE"` (`52 49 44 45`) |
| 4 | `u16` | version | Format version, `1` |
| 6 | `u16` | headerSize | Bytes from offset 0 to the first chunk. `24` in v1; readers must honour larger values (future header fields) |
| 8 | `f64` | startTime | Session start, ms since epoch. `NaN` if never started |
| 16 | `f64` | endTime | Session stop, ms since epoch. `NaN` while not stopped |

### 2.2 Chunks

Directly after the header follows a sequence of chunks until 4 bytes before the end:

| Offset (relative) | Type | Field |
| ---: | --- | --- |
| 0 | `char[4]` | chunk id |
| 4 | `u32` | payload length *L* in bytes |
| 8 | `u8[L]` | payload |

There is no padding between chunks. Each chunk id appears at most once. Chunks may appear in any order,
but writers emit `META`, `EVNT`, `BIKE`, `HRTR`.

### 2.3 Checksum

The last 4 bytes are a `u32` **CRC-32** (IEEE 802.3 – the same as zip, PNG and Python's `zlib.crc32`:
reflected polynomial `0xEDB88320`, initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`) over **all
preceding bytes** (header and chunks).

## 3. Chunk definitions

### 3.1 `META` – metadata

UTF-8 encoded JSON object. Free-form; the library uses these keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `title` | string | Title of the session |
| `notes` | string | Notes (exported to TCX `<Notes>`) |
| `devices` | object | `{bike: {name}, heartRateMonitor: {name}}` written by `SessionTracker` |

Applications may add their own keys (athlete weight, FTP, game level, …). Readers must ignore unknown keys.

### 3.2 `EVNT` – session events

| Type | Field |
| --- | --- |
| `u32` | count *N* |
| *N* × 5 bytes | records |

Record:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | `t` – ms since startTime |
| 4 | `u8` | event code |

| Code | Event | Meaning |
| ---: | --- | --- |
| 1 | `start` | Recording started (always `t = 0`) |
| 2 | `pause` | Recording paused |
| 3 | `resume` | Recording resumed |
| 4 | `lap` | A new lap starts at `t` |
| 5 | `stop` | Session ended |

Records are sorted by `t`. Readers skip unknown codes. Laps are derived from events: lap 0 starts at
`start`, every `lap` event starts the next lap, the last lap ends at `stop`.

### 3.3 `BIKE` – bike samples

| Type | Field |
| --- | --- |
| `u32` | count *N* |
| `u32` | channel mask *M* |
| *N* × (4 + 4·popcount(*M*)) bytes | records |

Record: `u32 t`, then one **`f32` per set bit of *M*, in ascending bit order**.

| Bit | Channel | Unit |
| ---: | --- | --- |
| 0 | `power` | W |
| 1 | `cadence` | rpm |
| 2 | `speed` | km/h |
| 3 | `distance` | m, cumulative since session start |
| 4 | `resistance` | trainer resistance level (device units) |
| 5–31 | reserved | |

- A missing value is stored as `NaN`.
- Writers set a bit only when at least one sample has a value for that channel.
- Because every channel is exactly 4 bytes, readers can skip channels whose bit they do not know.
- Records are sorted by `t`. A sample describes the interval *leading up to* `t`.

### 3.4 `HRTR` – heart-rate samples

Heart rate is stored as its own time series (it is never forced onto bike sample times).

| Type | Field |
| --- | --- |
| `u32` | count *N* |
| *N* × variable | records |

Record:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | `t` – ms since startTime |
| 4 | `u16` | heart rate in bpm, `0` = no value |
| 6 | `u8` | RR interval count *K* (0 – 255) |
| 7 | *K* × `u16` | RR intervals in **1/1024 s** (the native Bluetooth resolution: lossless) |

RR in ms = value × 1000 / 1024. Records are sorted by `t`.

## 4. Rules

**Writers must**

1. write the header with the current version and `headerSize`;
2. sort events and samples by `t`; use integer ms offsets;
3. write each chunk at most once;
4. append the CRC-32 of everything before it.

**Readers must**

1. check the magic, and reject `version` greater than they support;
2. verify the CRC-32 (the JavaScript library allows opting out with `{verifyChecksum: false}` for recovery);
3. start reading chunks at `headerSize`, not at a hard-coded 24;
4. skip unknown chunk ids, unknown event codes and unknown channel bits;
5. reject chunks whose length runs past the checksum.

**Versioning.** Adding chunks, channels, event codes or META keys does *not* change the version –
old readers simply skip them. The version is only increased for changes old readers cannot handle.

## 5. Precision and limits

| Quantity | Storage | Precision / limit |
| --- | --- | --- |
| Time offset | `u32` ms | 1 ms, max ≈ 49.7 days |
| Start/end time | `f64` ms | exact |
| Bike channels | `f32` | ~7 significant digits (e.g. 0.01 m at 100 km) |
| Heart rate | `u16` | 1 bpm |
| RR intervals | `u16` 1/1024 s | lossless vs. the sensor, max 64 s, ≤ 255 per sample |

Converting JavaScript numbers to `f32` rounds non-integer values slightly (e.g. `30.1` → `30.100000381…`).
Decoding and re-encoding a RIDE file is byte-identical, so editing round-trips are lossless after the first save.

Size: 24 (header) + 8 per chunk + META + 4 + 5 per event + (4 + 4·channels) per bike sample + (7 + 2·RR) per
heart-rate sample + 4 (CRC). A one-hour ride with 1 Hz bike data (5 channels) and 1 Hz heart rate with one RR
value per sample is ≈ 3600 · 24 + 3600 · 9 ≈ 119 kB (≈ 159 kB as base64).

## 6. Worked example

A 2-second session titled "Demo" with one bike sample and one heart-rate sample (131 bytes):

```
0000  52 49 44 45 01 00 18 00 00 00 90 ff 8f b7 79 42   RIDE, v1, header 24, startTime …
0010  00 00 0d 00 90 b7 79 42 4d 45 54 41 10 00 00 00   … endTime, "META" len 16
0020  7b 22 74 69 74 6c 65 22 3a 22 44 65 6d 6f 22 7d   {"title":"Demo"}
0030  45 56 4e 54 0e 00 00 00 02 00 00 00 00 00 00 00   "EVNT" len 14, 2 events, t=0 …
0040  01 d0 07 00 00 05 42 49 4b 45 1c 00 00 00 01 00   … start, t=2000 stop, "BIKE" len 28, 1 sample …
0050  00 00 0f 00 00 00 e8 03 00 00 00 00 48 43 00 00   … mask 0b1111, t=1000, 200.0 W, …
0060  b4 42 00 00 f0 41 00 00 08 41 48 52 54 52 0d 00   … 90 rpm, 30 km/h, 8.5 m, "HRTR" len 13
0070  00 00 01 00 00 00 e8 03 00 00 78 00 01 00 02 00   1 sample, t=1000, 120 bpm, 1 RR = 512/1024 s, CRC …
0080  26 8b 65                                          … CRC-32 = 0x658b2600
```

The same session as base64 text:

```
UklERQEAGAAAAJD/j7d5QgAADQCQt3lCTUVUQRAAAAB7InRpdGxlIjoiRGVtbyJ9RVZOVA4AAAACAAAAAAAAAAHQBwAABUJJS0UcAAAAAQAAAA8AAADoAwAAAABIQwAAtEIAAPBBAAAIQUhSVFINAAAAAQAAAOgDAAB4AAEAAgAmi2U=
```

## 7. Reference implementations

**JavaScript** – this library:

```js
import { Session } from './src/session_tracker.module.js';

const bytes = session.toBinary();            // Uint8Array
const text = session.toBase64();             // string
const copy = Session.fromBinary(bytes);      // or Session.fromBase64(text) / Session.parse(text)
```

Lower-level: `encodeSession(session)`, `decodeSession(bytes, {verifyChecksum})`, `crc32(bytes)`,
`bytesToBase64(bytes)`, `base64ToBytes(text)`.

**Python** – a complete, dependency-free decoder (for back ends and data analysis):

```python
import json, struct, zlib

CHANNELS = ['power', 'cadence', 'speed', 'distance', 'resistance']
EVENTS = {1: 'start', 2: 'pause', 3: 'resume', 4: 'lap', 5: 'stop'}

def decode_ride(data: bytes) -> dict:
    if data[:4] != b'RIDE':
        raise ValueError('not a RIDE session')
    version, header_size = struct.unpack_from('<HH', data, 4)
    if version > 1:
        raise ValueError(f'unsupported version {version}')
    body_end = len(data) - 4
    if struct.unpack_from('<I', data, body_end)[0] != zlib.crc32(data[:body_end]):
        raise ValueError('checksum mismatch')
    start, end = struct.unpack_from('<dd', data, 8)
    nan_to_none = lambda v: None if v != v else v
    session = {'startTime': nan_to_none(start), 'endTime': nan_to_none(end), 'meta': {},
               'events': [], 'bikeSamples': [], 'heartRateSamples': []}
    offset = header_size
    while offset < body_end:
        chunk_id = data[offset:offset + 4].decode('ascii')
        (length,) = struct.unpack_from('<I', data, offset + 4)
        p = offset + 8
        if chunk_id == 'META':
            session['meta'] = json.loads(data[p:p + length] or b'{}')
        elif chunk_id == 'EVNT':
            (count,) = struct.unpack_from('<I', data, p)
            for i in range(count):
                t, code = struct.unpack_from('<IB', data, p + 4 + 5 * i)
                if code in EVENTS:
                    session['events'].append({'t': t, 'type': EVENTS[code]})
        elif chunk_id == 'BIKE':
            count, mask = struct.unpack_from('<II', data, p)
            bits = [b for b in range(32) if mask >> b & 1]
            q = p + 8
            for _ in range(count):
                sample = {'t': struct.unpack_from('<I', data, q)[0]}
                q += 4
                for bit in bits:
                    (value,) = struct.unpack_from('<f', data, q)
                    q += 4
                    if bit < len(CHANNELS):
                        sample[CHANNELS[bit]] = nan_to_none(value)
                session['bikeSamples'].append(sample)
        elif chunk_id == 'HRTR':
            (count,) = struct.unpack_from('<I', data, p)
            q = p + 4
            for _ in range(count):
                t, bpm, k = struct.unpack_from('<IHB', data, q)
                q += 7
                rr = [v * 1000 / 1024 for v in struct.unpack_from(f'<{k}H', data, q)]
                q += 2 * k
                session['heartRateSamples'].append({'t': t, 'heartRate': bpm or None, 'rr': rr})
        offset = p + length
    return session
```

The output of `decode_ride` has the same shape as `session.toJSON()` in JavaScript.

## 8. Storing sessions in a database

Store the bytes as a binary column and copy the few fields you want to query into ordinary columns:

```sql
CREATE TABLE ride_session (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL,      -- from startTime
    duration_s  INTEGER     NOT NULL,      -- from getStats().elapsedTime
    distance_m  REAL,                      -- from getStats().distance
    avg_power_w REAL,                      -- from getStats().power.avg
    data        BYTEA       NOT NULL       -- session.toBinary()  (BLOB in MySQL/SQLite)
);
```

If your storage only handles text (JSON documents, key-value stores, `localStorage`), store `session.toBase64()`.
In the browser, IndexedDB can store the `Uint8Array` directly.
