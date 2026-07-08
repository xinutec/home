# Smart-plug energy monitoring (POSTPONED — resume notes)

Goal: monitor four smart plugs' electrical data (power, voltage, current,
cumulative energy) in the home dashboard, by **reflashing them to open firmware**
so they report to us directly — no Tuya cloud, no Tuya app, no rotating keys.

Status as of 2026-07-08: **backend scaffolding done and committed; hardware
reflash + poller + UI not started.** Paused at the user's request.

## The devices

Four ENERJSMART Wi-Fi smart plugs (energy-metering models) on the home LAN. They
are Tuya OEM devices; three carry Espressif MACs (ESP8266/ESP8285-class), the
fourth is a different vendor (possibly Beken BK7231 — **unconfirmed**, decides
Tasmota vs OpenBeken).

| Appliance    | IP            | MAC                 | Chip (inferred)      |
|--------------|---------------|---------------------|----------------------|
| Fan          | 192.168.1.102 | 24:62:ab:53:f3:0d   | Espressif            |
| Coffee machine | 192.168.1.44 | 24:62:ab:53:f2:8b  | Espressif            |
| Desktop PC   | 192.168.1.178 | 24:62:ab:53:f3:59   | Espressif            |
| TV           | 192.168.1.139 | c4:dd:57:14:c5:5e   | non-Espressif (Beken?) |

All speak the Tuya local protocol on TCP **6668**, protocol version **3.3**.
Local DPS observed: `1`=relay on/off, `18`=current (mA), `19`=power (W, ×10),
`20`=voltage (V, ×10, e.g. 2382 = 238.2 V). The cloud also exposes `add_ele`
(cumulative energy, kWh, scale 3) though it isn't in the steady-state local poll.

## Target architecture (after reflash)

```
Tasmota plug (LAN) --HTTP JSON (Status 10)--> Mac poller --/api/ingest--> home.xinutec.org
```

Mirrors the existing IQAir/Govee pushers: a Mac launchd poller HTTP-GETs each
plug's energy JSON every 5 min and pushes it through `spool.deliver`. Tasmota
keeps its own cumulative kWh counter, so we get real energy natively.

## What is DONE (committed 71950e8)

Firmware-agnostic backend, ready and waiting (NOT deployed — no data flows yet):
- **Migration v4** (`src/db/schema.ts`): `power_w`, `voltage_v`, `current_a`,
  `energy_kwh`, `power_on` columns on `measurement` (all nullable).
- **Ingest** (`src/measurement.ts`, `src/routes/api.ts`): validates + stores the
  five fields; relay state as a boolean → 0/1.
- **Labels** (`src/labels.ts`): `socket-fan` / `socket-coffee` / `socket-desk` /
  `socket-tv`, each `power: true`, named by appliance.
- **Frontend guard** (`frontend/.../measurement.model.ts`, `api.service.ts`):
  power plugs filtered out of the climate room views, exposed as a separate
  `powerDevices` computed for the future power section.
- Tests added; full verify green.

## What is PENDING

1. Buy a 3.3 V USB-TTL serial adapter (FT232RL — candidate: DORHEA FT232RL
   Type-C 2-pack). **Must be set to 3.3 V** — ESP/Beken are not 5 V-tolerant.
2. Read the plug **model number** off the label; open one plug, identify the
   chip + flash pads (confirms Tasmota vs OpenBeken and the fourth plug's chip).
3. **Reflash** all four over serial. Flash software runs on the Mac:
   `ltchiptool` (universal ESP+Beken flasher; back up original firmware first),
   target **Tasmota** for the ESP plugs (OpenBeken if any are Beken).
   Wiring: FTDI GND→GND, 3V3→VCC, TX→plug RX, RX→plug TX, plug GPIO0→GND at
   power-on for flash mode. **Power from the FTDI 3.3 V only — never with the
   plug in mains** while wired to serial.
4. Build the **Tasmota poller** in `xinutec-infra/mac-mini/` (HTTP-poll each
   plug's `Status 10` → `spool.deliver` → `/api/ingest/batch`) + a launchd agent
   in `hm-agents.nix`. Mirror `govee-push.py` / `spool.py`.
5. **Calibrate** the BL0937/HLW8012 metering (GPIO template + voltage/current/
   power multipliers against a known load).
6. **Frontend power section**: render `powerDevices` (live W + kWh history).
7. **Deploy** home (migration applies on startup).

Alternative flashing route not taken: OTA via `tuya-cloudcutter` on a
Raspberry Pi (borrows the Pi's Wi-Fi radio for ~30 min — non-destructive to the
Pi; needs the Pi wired on Ethernet or a second Wi-Fi dongle). Firmware-version
dependent and may fail on these modern-SDK plugs; serial is the guaranteed route.

## History (the years of energy charts in the app) — separate, deferred

Not recoverable programmatically:
- **Tuya open API**: the device-statistics / energy-consumption endpoints are
  gated. Subscribing the free-trial **"Power Management"** cloud service on the
  Tuya IoT project unlocks them, but they return **0 for every one of these
  devices** (the OEM product isn't enrolled in Tuya's open-API statistical
  category — a manufacturer service ticket we can't file). The free trial is
  left active; harmless.
- **App private API**: both the Smart Life and ENERJSMART apps use Tuya's
  hardened signing (stego key in `assets/fixed_key.bmp` + cert pinning, verified
  by decompiling the ENERJSMART APK). Replicating it is a multi-day, brittle
  reverse-engineering effort; abandoned.
- Reflashing does **not** recover it (history lives in Tuya's cloud, not on the
  device).

**Plan**: later, one-time, the user reads the per-month figures from the app by
hand and we transcribe whatever is there into the DB. Not automated.

## Context that would otherwise be lost

- The plugs were re-paired from the **ENERJSMART** app into the **Smart Life**
  app (`com.tuya.smartlife`) to link a Tuya IoT project (`home-sockets`, region
  `eu`) — done to extract local keys and probe the cloud. Once reflashed, both
  apps drop out of the picture entirely.
- Local keys are re-derivable any time from the `home-sockets` Tuya IoT project
  via the `tinytuya` wizard (not stored here). Only needed if we ever fall back
  to LocalTuya instead of reflashing.
