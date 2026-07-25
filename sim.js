/* =====================================================================
 * gPTP / STBM Time Synchronization Visualizer
 * ---------------------------------------------------------------------
 * Models a vehicle-domain Grandmaster (Master) distributing time to an
 * SRR sensor (Slave) over an IEEE 802.1AS (gPTP) link, managed by an
 * AUTOSAR-style Synchronized Time-Base Manager (STBM).
 *
 * Requirements modelled
 *  - 32-bit, 1 ms resolution internal (slave) clock, epoch based.
 *  - Sync applied via a commanded message carrying a time shift vs the
 *    Master Clock.
 *  - gPTP target accuracy 500 us.
 *  - Cycle time within 1 ms of commanded time, cycle-to-cycle jitter <1 ms.
 *  - When UNSYNCHRONIZED: always adopt the received master time.
 *  - When SYNCHRONIZED: adopt only if |deviation| < 6.25% of the time
 *    since the last successful synchronization (plausibility check),
 *    otherwise the sync is rejected (holdover).
 *  - Slave oscillator stability better than 0.1%.
 * ===================================================================== */

'use strict';

const CLOCK_MOD = 2 ** 32;            // 32-bit ms clock wrap
const PLAUS_FRACTION = 0.0625;        // 6.25%
const HISTORY_SAMPLE_MS = 25;         // fixed timestamp sampling grid
const NOMINAL_FREQ_KHZ = 1000;        // nominal reference clock = 1 MHz (1000 kHz)
const STABILITY_LIMIT = 0.1;          // % requirement
const JITTER_LIMIT = 1.0;             // ms
const ACCURACY_UNSYNC = Infinity;

/* ---------------- DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);

const els = {
  btnStart: $('btnStart'), btnPause: $('btnPause'), btnReset: $('btnReset'), btnToggleConfig: $('btnToggleConfig'),
  cfgStepEn: $('cfgStepEn'), cfgStep: $('cfgStep'),
  cfgStop: $('cfgStop'), cfgSpeed: $('cfgSpeed'), outSpeed: $('outSpeed'),
  cfgStepMode: $('cfgStepMode'), cfgPdelayEn: $('cfgPdelayEn'), cfgTsMode: $('cfgTsMode'),
  cfgEpoch: $('cfgEpoch'), cfgMasterFreq: $('cfgMasterFreq'), outMasterPpm: $('outMasterPpm'), cfgSyncInterval: $('cfgSyncInterval'),
  cfgTimeShift: $('cfgTimeShift'), cfgSlaveFreq: $('cfgSlaveFreq'), outSlavePpm: $('outSlavePpm'), cfgStability: $('cfgStability'),
  cfgCycle: $('cfgCycle'), cfgFreeze: $('cfgFreeze'), cfgSyncTimeout: $('cfgSyncTimeout'), cfgAcceptAll: $('cfgAcceptAll'), cfgAccuracy: $('cfgAccuracy'), cfgPdelay: $('cfgPdelay'), cfgStaticPath: $('cfgStaticPath'), cfgNoise: $('cfgNoise'), cfgSyncJitter: $('cfgSyncJitter'),
  cfgFrameSpeed: $('cfgFrameSpeed'), outFrameSpeed: $('outFrameSpeed'),
  btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), outZoom: $('outZoom'),
  masterHuman: $('masterHuman'), masterRaw: $('masterRaw'),
  slaveHuman: $('slaveHuman'), slaveRaw: $('slaveRaw'), slaveState: $('slaveState'),
  statDev: $('statDev'), statDevBar: $('statDevBar'),
  statAcc: $('statAcc'), statAccSub: $('statAccSub'),
  statWindow: $('statWindow'), statWindowSub: $('statWindowSub'),
  statJitter: $('statJitter'), statSimTime: $('statSimTime'), statSyncCount: $('statSyncCount'),
  nodeMaster: $('nodeMaster'), nodeSlave: $('nodeSlave'),
  linkCanvas: $('linkCanvas'), graphCanvas: $('graphCanvas'), clockCanvas: $('clockCanvas'), log: $('log'),
  alerts: $('alerts'),
  pdAt: $('pdAt'), pdResult: $('pdResult'), pdVals: $('pdVals'),
  syAt: $('syAt'), syResult: $('syResult'), syVals: $('syVals'), syCorrection: $('syCorrection'), syVerdict: $('syVerdict'),
  frameLegend: $('frameLegend'), linkLabel: $('linkLabel'), pdBlock: $('pdBlock'), pdBlockHead: $('pdBlockHead'), fDelta: $('fDelta'), mkT1desc: $('mkT1desc'),
  cfgHwTs: $('cfgHwTs'), cfgPollPeriod: $('cfgPollPeriod'), cfgBusLoad: $('cfgBusLoad'), outBusLoad: $('outBusLoad'), cfgBusMax: $('cfgBusMax'),
  cfgTimeLeap: $('cfgTimeLeap'),
  stbmTime: $('stbmTime'), stbmHwTs: $('stbmHwTs'), stbmNotify: $('stbmNotify'), stbmLeap: $('stbmLeap'),
  timerCanvas: $('timerCanvas'),
};

const linkCtx = els.linkCanvas.getContext('2d');
const graphCtx = els.graphCanvas.getContext('2d');
const clockCtx = els.clockCanvas.getContext('2d');
const timerCtx = els.timerCanvas.getContext('2d');

/* ---------------- HiDPI canvas setup ----------------
 * Each canvas keeps a fixed *logical* coordinate space (its original width/
 * height attributes) so all drawing code is unchanged, but the backing store is
 * sized to the displayed CSS size × devicePixelRatio. A base transform maps the
 * logical space onto that high-resolution store, so text and lines render crisp
 * instead of being blurred by CSS up/down-scaling. _w/_h expose the logical
 * dimensions to the draw functions.
 */
const CANVASES = [
  { el: els.linkCanvas, ctx: linkCtx, w: els.linkCanvas.width, h: els.linkCanvas.height },
  { el: els.timerCanvas, ctx: timerCtx, w: els.timerCanvas.width, h: els.timerCanvas.height },
  { el: els.graphCanvas, ctx: graphCtx, w: els.graphCanvas.width, h: els.graphCanvas.height },
  { el: els.clockCanvas, ctx: clockCtx, w: els.clockCanvas.width, h: els.clockCanvas.height },
];
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.el.clientWidth || c.w;              // displayed width (canvas is width:100%)
  const cssH = cssW * (c.h / c.w);                   // keep the logical aspect ratio
  c.el.style.height = cssH + 'px';                   // pin CSS height so aspect stays fixed
  c.el.width = Math.round(cssW * dpr);
  c.el.height = Math.round(cssH * dpr);
  // Map logical (c.w × c.h) coordinates onto the physical backing store.
  c.ctx.setTransform(c.el.width / c.w, 0, 0, c.el.height / c.h, 0, 0);
  c.el._w = c.w;
  c.el._h = c.h;
  c.ctx.textBaseline = 'alphabetic';
}
function fitAllCanvases() { CANVASES.forEach(fitCanvas); }
fitAllCanvases();
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    fitAllCanvases();
    drawLink(); drawTimers(); drawGraph(); drawClocks();
  });
});

/* ---------------- Simulation state ---------------- */
let cfg = {};
let state = {};

// View controls (persist across resets)
const view = {
  spanMs: 4000,          // visible time window on the time-series graphs
  frameSpeed: 0.4,       // <1 = slower frame animation
};
const ZOOM_MIN = 250;    // ms
const ZOOM_MAX = 120000; // ms

function readConfig() {
  const masterFreq = Math.max(1, +els.cfgMasterFreq.value);   // kHz
  const slaveFreq = Math.max(1, +els.cfgSlaveFreq.value);     // kHz
  // Frequency offset vs the nominal 1 MHz reference, in ppm.
  const masterPpm = (masterFreq / NOMINAL_FREQ_KHZ - 1) * 1e6;
  const slavePpm = (slaveFreq / NOMINAL_FREQ_KHZ - 1) * 1e6;
  cfg = {
    startMs: 0,                          // run always starts at simulation time 0
    stopMs: +els.cfgStop.value,          // total length; 0 = infinite
    speed: +els.cfgSpeed.value,
    epoch: +els.cfgEpoch.value,
    masterFreq, slaveFreq,               // kHz
    masterPpm,
    syncInterval: Math.max(10, +els.cfgSyncInterval.value),
    timeShift: +els.cfgTimeShift.value,
    slavePpm,
    stability: Math.max(0, +els.cfgStability.value),   // %
    cycleTime: Math.max(10, +els.cfgCycle.value),
    freeze: els.cfgFreeze.checked,
    syncTimeout: Math.max(0, +els.cfgSyncTimeout.value),
    timeLeapMs: Math.max(0, +els.cfgTimeLeap.value),
    acceptAll: els.cfgAcceptAll.checked,
    accuracyUs: +els.cfgAccuracy.value,
    pdelayInterval: Math.max(50, +els.cfgPdelay.value),
    staticPathUs: Math.max(0, +els.cfgStaticPath.value),  // assumed link delay when Pdelay off
    stepMode: +els.cfgStepMode.value,     // 1 = one-step, 2 = two-step
    pdelayEn: els.cfgPdelayEn.checked,    // peer-delay handshake enabled
    noiseUs: Math.max(0, +els.cfgNoise.value),
    syncJitter: Math.max(0, +els.cfgSyncJitter.value),
    hwTs: els.cfgHwTs.checked,
    pollPeriod: Math.max(0, +els.cfgPollPeriod.value),
    busLoad: Math.max(0, Math.min(100, +els.cfgBusLoad.value)) / 100,
    busMax: Math.max(0, +els.cfgBusMax.value),
  };
  updateFreqReadouts();
}

// Show derived ppm next to each frequency input.
function updateFreqReadouts() {
  const mPpm = (cfg.masterFreq / NOMINAL_FREQ_KHZ - 1) * 1e6;
  const sPpm = (cfg.slaveFreq / NOMINAL_FREQ_KHZ - 1) * 1e6;
  els.outMasterPpm.textContent = `${mPpm >= 0 ? '+' : ''}${Math.round(mPpm)} ppm (${cfg.masterFreq} kHz)`;
  els.outSlavePpm.textContent = `${sPpm >= 0 ? '+' : ''}${Math.round(sPpm)} ppm (${cfg.slaveFreq} kHz)`;
}

function resetState() {
  readConfig();
  state = {
    running: false,
    finished: false,                     // true once the run reaches Length (Start then restarts)
    simTime: cfg.startMs,
    lastFrame: 0,
    // slave oscillator
    slaveClock: 0,                       // ms (float, floored to 1 ms for display)
    slaveWander: 0,                      // ppm random-walk component
    synchronized: false,
    lastSyncTime: -Infinity,             // sim time of last *successful* sync
    nextSyncTime: cfg.startMs + cfg.syncInterval,
    // cycle model
    nextCycleTime: cfg.startMs + cfg.cycleTime,
    lastCyclePeriod: cfg.cycleTime,
    prevCycleWall: null,
    jitter: 0,
    // gPTP peer-delay
    nextPdelayTime: cfg.startMs + cfg.pdelayInterval,
    nextSampleTime: cfg.startMs,
    meanPathDelayUs: 0.3,
    lastPdelay: null,
    lastSync: null,
    lastPdelayReady: null,          // Pdelay snapshot latched when its resp lands (drives δ panel)
    lastSyncReady: null,            // Sync snapshot latched when its Follow_Up lands (drives offset panel)
    syPartial: {},                  // per-term Sync values latched incrementally as the animation reveals them
    tsLabels: {},                   // on-diagram timestamp labels latched by the animation
    // STBM / Eth RX polling
    notifyDelay: 0,
    stbmSyncTime: null,
    stbmHwTs: null,
    rxMasterTs: null,               // last master timestamp carried by Sync/Follow_Up
    lastCorrection: 0,              // ms, last applied clock correction
    timeLeap: false,               // STBM timeLeap status flag (last correction ≥ threshold)
    timeLeapAt: -1e9,              // sim time of last timeLeap
    // stats
    syncCount: 0,
    deviation: 0,
    history: [],                         // {t, dev, envelope}
    packets: [],                         // animated frames on the link
    events: [],
  };
  els.log.innerHTML = '';
  // initialise slave clock at epoch-relative 0
  state.slaveClock = 0;
  drawTimers();
  drawGraph();
  drawLink();
  updateComputePanels();          // render the calc term rows with — placeholders
  updateReadouts(true);
}

/* ---------------- Clock math ---------------- */
// Master time = epoch + elapsed * master rate. Master is the reference grandmaster.
function masterTime(t = state.simTime) {
  const rate = 1 + cfg.masterPpm / 1e6;
  return cfg.epoch + (t - cfg.startMs) * rate;
}

function randn() {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Instantaneous slave oscillator rate, bounded by stability requirement.
function slaveRate() {
  const boundPpm = cfg.stability * 1e4;            // 0.1% -> 1000 ppm
  state.slaveWander += randn() * boundPpm * 0.02;  // slow random walk
  state.slaveWander = Math.max(-boundPpm, Math.min(boundPpm, state.slaveWander));
  return 1 + (cfg.slavePpm + state.slaveWander) / 1e6;
}

/* ---------------- Sync handling ---------------- */
function performSync() {
  // --- gPTP offset computation from hardware timestamps ---
  // The link has a real physical propagation delay that is always present in
  // the Sync ingress timestamp. When Pdelay is enabled the delay is measured by
  // the handshake (meanPathDelayUs) and compensated; when disabled we assume a
  // static configured link delay that is NOT compensated, so it leaks into the
  // recovered offset as a fixed error.
  const physMpdMs = (cfg.pdelayEn ? state.meanPathDelayUs : cfg.staticPathUs) / 1000; // real link delay (always in t2)
  const usedMpdMs = cfg.pdelayEn ? physMpdMs : 0;       // subtracted only if Pdelay on
  const residenceUs = 4 + Math.random() * 4;            // correctionField (residence)
  const corrMs = residenceUs / 1000;
  const noiseMs = (cfg.noiseUs / 1000) * (Math.random() * 2 - 1); // timestamp granularity/error

  const slaveAbs = cfg.epoch + state.slaveClock;        // slave HW clock "now"
  // t1 = preciseOriginTimestamp (master egress), including commanded time shift.
  const t1 = masterTime() + cfg.timeShift;
  const trueOffset = slaveAbs - t1;                     // real clock error slave-master

  // Ethernet RX is serviced in POLLING mode: the Sync frame's ingress time is
  // captured, but software only processes it at the next poll, delayed further
  // by contention from other bus traffic → a *variable* notify delay.
  const pollWait = cfg.pollPeriod > 0 ? Math.random() * cfg.pollPeriod : 0;
  const contention = Math.random() * cfg.busMax * cfg.busLoad;
  const notifyDelay = pollWait + contention;            // ms, variable per sync

  // t2 = Sync ingress timestamp on the slave.
  //  · With Ethernet HW timestamping, t2 is captured by the MAC at ingress and
  //    is ACCURATE regardless of the polling latency (delay only affects *when*
  //    the STBM state is updated, not the value).
  //  · Without HW timestamping (software timestamp at poll service), the
  //    variable notify delay leaks directly into t2 → error + jitter.
  const t2Hw = t1 + trueOffset + physMpdMs + corrMs + noiseMs;
  const tsError = cfg.hwTs ? 0 : notifyDelay;
  const t2 = t2Hw + tsError;
  // Recovered offset after removing path delay and residence (correctionField).
  const offsetFromMaster = t2 - t1 - usedMpdMs - corrMs;    // = trueOffset + noise (+ unpaid δ if Pdelay off)

  const deviation = offsetFromMaster;                   // slave - master
  const timeSinceLast = state.simTime - state.lastSyncTime;
  const window = PLAUS_FRACTION * timeSinceLast;        // 6.25% envelope

  // The received Sync/Follow_Up always carries a fresh master timestamp,
  // regardless of the local oscillator state. Record it for the plot.
  state.rxMasterTs = t1;

  // STBM sync-loss timeout: if no valid sync has been APPLIED for longer than
  // the timeout (e.g. because the local clock is frozen and every sync fails
  // the 6.25% plausibility check → holdover), the time base reverts to
  // UNSYNCHRONIZED. The next Sync is then adopted unconditionally, stepping
  // the slave time up to the master value.
  if (state.synchronized && cfg.syncTimeout > 0 && timeSinceLast >= cfg.syncTimeout) {
    state.synchronized = false;
    log('warn', 'SYNC-LOSS', `Sync-loss timeout (${timeSinceLast.toFixed(0)} ms without valid sync) → UNSYNCHRONIZED`);
  }

  let outcome, correction = 0;
  if (!state.synchronized) {
    // Unsynchronized -> always adopt master time.
    state.slaveClock -= offsetFromMaster;
    correction = -offsetFromMaster;
    state.synchronized = true;
    state.lastSyncTime = state.simTime;
    state.syncCount++;
    outcome = 'init';
    flashNode('slave');
    log('ok', 'SYN INIT', `Initial SYNC — offsetFromMaster ${fmtSigned(offsetFromMaster)}, correction ${fmtSigned(correction)}`);
  } else if (cfg.acceptAll || Math.abs(deviation) < window) {
    // Accept-all mode, or synchronized & within plausibility window -> apply.
    state.slaveClock -= offsetFromMaster;
    correction = -offsetFromMaster;
    state.lastSyncTime = state.simTime;
    state.syncCount++;
    outcome = 'apply';
    flashNode('slave');
    const why = cfg.acceptAll ? 'accept-all' : `offset ${fmtSigned(offsetFromMaster)} < window ±${window.toFixed(2)} ms`;
    log('ok', 'SYN OK', `SYNC applied — ${why}, correction ${fmtSigned(correction)}`);
  } else {
    // Deviation exceeds plausibility window -> reject (holdover).
    outcome = 'reject';
    flashNode('reject');
    log('rej', 'SYN REJ', `SYNC REJECTED — offset ${fmtSigned(offsetFromMaster)} ≥ window ±${window.toFixed(2)} ms (holdover)`);
  }

  // STBM synchronized time-base value (post-correction) and its inputs.
  state.notifyDelay = notifyDelay;
  state.stbmSyncTime = (cfg.epoch + state.slaveClock);
  state.stbmHwTs = t2Hw;

  // STBM timeLeap: raise the status flag when a single applied correction is
  // large enough to be a discontinuous "jump" of the synchronized time base
  // (|correction| ≥ configured threshold). A reject applies no correction, so
  // it cannot raise a leap.
  state.lastCorrection = correction;
  const isLeap = outcome !== 'reject' && cfg.timeLeapMs > 0 && Math.abs(correction) >= cfg.timeLeapMs;
  state.timeLeap = isLeap;
  if (isLeap) {
    state.timeLeapAt = state.simTime;
    const dir = correction >= 0 ? 'FORWARD' : 'BACKWARD';
    log('warn', 'LEAP', `STBM timeLeap (${dir}) — correction ${fmtSigned(correction)} ≥ ±${cfg.timeLeapMs} ms threshold`);
  }

  state.deviation = state.synchronized ? (cfg.epoch + state.slaveClock) - masterTime() : deviation;
  const sy = {
    at: state.simTime, t1, t2, t2Hw, mpdMs: usedMpdMs, physMpdMs, residenceUs, corrMs,
    notifyDelay, hwTs: cfg.hwTs, pdelayEn: cfg.pdelayEn, stepMode: cfg.stepMode,
    offsetFromMaster, deviation, window, timeSinceLast, correction, outcome,
    inSpec: Math.abs(offsetFromMaster) <= cfg.accuracyUs / 1000,
  };
  state.lastSync = sy;

  // gPTP Sync animation. In TWO-STEP mode the Sync frame reveals t₁ on
  // departure (master egress) and t₂ on arrival (slave ingress); a following
  // Follow_Up carries the correctionField c and (visually) the poll notify
  // delay Δp, latching the derived offset panel when it lands. In ONE-STEP mode
  // the Sync frame itself carries t₁ and c (no Follow_Up), so all reveals and
  // the snapshot ride on the single Sync frame. Each frame carries its own
  // values so pipelined exchanges stay in step.
  const fmtMs = (v) => `${v.toFixed(3)} ms`;
  // Begin a fresh incremental calculation: δ (from the prior Pdelay) and the
  // active-term config are known up front; t₁/t₂/c/Δp fill in as the animation
  // reveals them, and the final offset is computed once all are present.
  state.syPartial = { at: state.simTime, pdelayEn: cfg.pdelayEn, hwTs: cfg.hwTs, physMpdMs };
  if (cfg.stepMode === 1) {
    spawnFrame('Sync', 1, '#58a6ff', 0, {
      reveals: [
        { p: 0, key: 'Sync:L', sym: 't₁', color: TS_SY, val: fmtMs(t1), calc: { f: 't1', v: t1 } },
        { p: 0, key: 'SyncC:L', sym: 'c', color: TS_C, val: `${residenceUs.toFixed(2)} µs`, calc: { f: 'residenceUs', v: residenceUs } },
        { p: 1, key: 'Sync:R', sym: 't₂', color: TS_SY, val: fmtMs(t2), calc: { f: 't2', v: t2 } },
        { p: 1, key: 'SyncC:R', sym: 'Δp', color: TS_DP, val: `${notifyDelay.toFixed(3)} ms`, calc: { f: 'notifyDelay', v: notifyDelay } },
      ],
      snap: { kind: 'sync', data: sy },
    });
  } else {
    spawnFrame('Sync', 1, '#58a6ff', 0, {
      reveals: [
        { p: 0, key: 'Sync:L', sym: 't₁', color: TS_SY, val: fmtMs(t1), calc: { f: 't1', v: t1 } },
        { p: 1, key: 'Sync:R', sym: 't₂', color: TS_SY, val: fmtMs(t2), calc: { f: 't2', v: t2 } },
      ],
    });
    spawnFrame('Follow_Up', 1, '#79c0ff', SYNC_TO_FUP_MS, {
      reveals: [
        { p: 0, key: 'Follow_Up:L', sym: 'c', color: TS_C, val: `${residenceUs.toFixed(2)} µs`, calc: { f: 'residenceUs', v: residenceUs } },
        { p: 1, key: 'Follow_Up:R', sym: 'Δp', color: TS_DP, val: `${notifyDelay.toFixed(3)} ms`, calc: { f: 'notifyDelay', v: notifyDelay } },
      ],
      snap: { kind: 'sync', data: sy },
    });
  }

  updateComputePanels();
}


/* ---------------- Cycle model ---------------- */
function tickCycle() {
  // A measurement cycle fires on the slave clock. Jitter is the deviation
  // of the actual (wall-referenced) period from the commanded cycle time.
  const period = cfg.cycleTime * slaveRateAvg() + (Math.random() * 2 - 1) * 0.4;
  if (state.prevCycleWall !== null) {
    state.jitter = Math.abs(period - state.lastCyclePeriod);
  }
  state.lastCyclePeriod = period;
  state.prevCycleWall = state.simTime;
}
function slaveRateAvg() { return 1 + cfg.slavePpm / 1e6; }

/* ---------------- gPTP peer-delay (Pdelay) handshake ---------------- */
// Two-step propagation-delay measurement. The slave port initiates:
//   t1 = Pdelay_Req egress   (slave HW timestamp)
//   t2 = Pdelay_Req ingress  (master HW timestamp, requestReceiptTimestamp)
//   t3 = Pdelay_Resp egress  (master HW timestamp, responseOriginTimestamp)
//   t4 = Pdelay_Resp ingress (slave HW timestamp)
//   meanPathDelay = ((t4 − t1) − (t3 − t2)) / 2
function tickPdelay() {
  // Physically-ordered handshake: the master can only send Pdelay_Resp AFTER
  // the Pdelay_Req has propagated across the link and a turnaround delay.
  //   Req egress        : t = 0
  //   Req arrives master : t = FRAME_TRAVEL_MS  (one-way propagation)
  //   Resp egress        : t = FRAME_TRAVEL_MS + turnaround
  //   Resp_Follow_Up     : t = FRAME_TRAVEL_MS + turnaround + PDELAY_FUP_MS
  const respStart = FRAME_TRAVEL_MS + PDELAY_TURNAROUND_MS;

  const pathUs = 0.28 + Math.random() * 0.12;           // one-way propagation (~automotive link)
  const turnUs = 8 + Math.random() * 4;                 // master turnaround (req→resp)
  const measNoiseUs = (Math.random() * 2 - 1) * 0.04;   // timestamp granularity
  // slave-vs-master offset cancels in the symmetric formula, but is included
  // so the individual timestamps look physically real.
  const offMs = (cfg.epoch + state.slaveClock) - masterTime();
  const t1 = cfg.epoch + state.slaveClock;              // slave timebase
  const t2 = (t1 - offMs) + pathUs / 1000;              // master timebase (ingress)
  const t3 = t2 + turnUs / 1000;                        // master timebase (egress)
  const t4 = (t3 + offMs) + pathUs / 1000 + measNoiseUs / 1000; // slave timebase (ingress)
  const mpdUs = (((t4 - t1) - (t3 - t2)) / 2) * 1000;

  state.meanPathDelayUs = mpdUs;
  const pd = { at: state.simTime, t1, t2, t3, t4, pathUs, turnUs, mpdUs };
  state.lastPdelay = pd;

  // Physically-ordered handshake animation. Pdelay_Req (slave→master) reveals
  // t₁ on departure (slave egress) and t₂ on arrival (master ingress).
  // Pdelay_Resp (master→slave) reveals t₃ on departure (master egress) and t₄
  // on arrival (slave ingress), and latches the meanPathDelay panel on arrival.
  const fmtMs = (v) => `${v.toFixed(3)} ms`;
  spawnFrame('Pdelay_Req', -1, '#f0b429', 0, {
    reveals: [
      { p: 0, key: 'Pdelay_Req:R', sym: 't₁', color: TS_PD, val: fmtMs(t1) },
      { p: 1, key: 'Pdelay_Req:L', sym: 't₂', color: TS_PD, val: fmtMs(t2) },
    ],
  });
  spawnFrame('Pdelay_Resp', 1, '#3fb950', respStart, {
    reveals: [
      { p: 0, key: 'Pdelay_Resp:L', sym: 't₃', color: TS_PD, val: fmtMs(t3) },
      { p: 1, key: 'Pdelay_Resp:R', sym: 't₄', color: TS_PD, val: fmtMs(t4) },
    ],
    snap: { kind: 'pdelay', data: pd },
  });
  spawnFrame('Pdelay_Resp_Follow_Up', 1, '#56d4b8', respStart + PDELAY_FUP_MS);

  log('info', 'PDELAY', `Pdelay exchange — meanPathDelay = ${mpdUs.toFixed(3)} µs`);
  updateComputePanels();
}

/* ---------------- Main loop ---------------- */
function step(ts) {
  if (!state.running) return;
  if (!state.lastFrame) state.lastFrame = ts;
  let dtReal = (ts - state.lastFrame);
  state.lastFrame = ts;
  dtReal = Math.min(dtReal, 100);          // clamp big gaps
  const dt = dtReal * cfg.speed;           // sim ms advanced this frame

  advance(dt);

  // stop condition
  if (cfg.stopMs > 0 && state.simTime >= cfg.stopMs) {
    state.simTime = cfg.stopMs;
    state.finished = true;
    stop();
    log('info', 'STOP', `Simulation stopped at ${Math.round(cfg.stopMs)} ms`);
    updateReadouts(true);
    return;
  }

  updateReadouts(false);
  requestAnimationFrame(step);
}

function advance(dt) {
  // Integrate in small sub-steps so sync/cycle events land accurately.
  let remaining = dt;
  while (remaining > 0) {
    const nextEvent = Math.min(state.nextSyncTime, state.nextCycleTime, state.nextPdelayTime, state.nextSampleTime);
    const stepDt = Math.min(remaining, Math.max(0.5, nextEvent - state.simTime));
    // advance slave clock by its own (drifting) rate — unless frozen/stopped
    if (!cfg.freeze) state.slaveClock += stepDt * slaveRate();
    state.simTime += stepDt;
    remaining -= stepDt;

    if (state.simTime + 1e-6 >= state.nextSyncTime) {
      performSync();
      const jit = (Math.random() * 2 - 1) * cfg.syncJitter;
      state.nextSyncTime += cfg.syncInterval + jit;
    }
    if (state.simTime + 1e-6 >= state.nextPdelayTime) {
      if (cfg.pdelayEn) tickPdelay();
      state.nextPdelayTime += cfg.pdelayInterval;
    }
    if (state.simTime + 1e-6 >= state.nextCycleTime) {
      tickCycle();
      state.nextCycleTime += cfg.cycleTime;
    }
    // Sample the timestamp/deviation history on a fixed 25 ms grid.
    while (state.simTime + 1e-6 >= state.nextSampleTime) {
      recordSample(state.nextSampleTime);
      state.nextSampleTime += HISTORY_SAMPLE_MS;
    }
  }

  // keep live readouts current (deviation used by tiles/alerts)
  const slaveAbs = cfg.epoch + state.slaveClock;
  state.deviation = slaveAbs - masterTime();

  advancePackets();
}

// Record one history sample at grid time t (ms).
function recordSample(t) {
  const slaveAbs = cfg.epoch + state.slaveClock;
  const dev = slaveAbs - masterTime(t);
  const envelope = state.synchronized
    ? PLAUS_FRACTION * (t - state.lastSyncTime)
    : Infinity;
  const nominal = cfg.epoch + (t - cfg.startMs);
  state.history.push({
    t,
    dev,
    env: envelope,
    mOff: masterTime(t) - nominal,
    sOff: slaveAbs - nominal,
    rxOff: state.rxMasterTs != null ? state.rxMasterTs - nominal : null,
  });
  const maxPts = 6000;
  if (state.history.length > maxPts) state.history.splice(0, state.history.length - maxPts);
}

/* ---------------- Link frame animation ----------------
 * Frames animate in SIMULATION time so their travel/turnaround durations are
 * tied to the modeled timeline: a frame that departs at sim time T arrives at
 * T + travel, and the whole handshake completes inside the run. This preserves
 * realistic gPTP ordering (Sync → Follow_Up, Pdelay_Req → Pdelay_Resp →
 * ..._Follow_Up) and guarantees exchanges finish before the run ends.
 * dir = 1 for master→slave, -1 for slave→master.
 */
const FRAME_TRAVEL_MS = 60;      // reference on-wire travel time (sim ms)
const SYNC_TO_FUP_MS = 15;       // Follow_Up after Sync (sim ms)
const PDELAY_TURNAROUND_MS = 12; // master req→resp turnaround (sim ms)
const PDELAY_FUP_MS = 15;        // Pdelay_Resp_Follow_Up after Pdelay_Resp
// Visual stretch of the animation timeline. frameSpeed < 1 slows the on-screen
// motion by lengthening the modeled travel/turnaround in sim time; > 1 speeds
// it up. All frame timings scale by this single factor so ordering is kept.
function frameScale() { return 1 / view.frameSpeed; }
function frameTravelSim() { return FRAME_TRAVEL_MS * frameScale(); }

function spawnFrame(type, dir, color, delaySimMs, opts) {
  const sc = frameScale();
  const pk = {
    type, dir, color,
    tStartSim: state.simTime + delaySimMs * sc,   // sim time this frame leaves
    durSim: FRAME_TRAVEL_MS * sc,                 // sim ms to cross the link
  };
  if (opts) {
    pk.reveals = opts.reveals || null;   // [{p, key, sym, color, val}] latched when progress ≥ p
    pk.snap = opts.snap || null;         // {kind:'sync'|'pdelay', data} latched on arrival (p ≥ 1)
    pk.revealed = false;                 // departure reveals applied
    pk.arrived = false;                  // arrival reveals/snapshot applied
  }
  state.packets.push(pk);
  return pk;
}
function advancePackets() {
  // Drop frames once they have finished crossing (in sim time). Keep a small
  // post-arrival margin so drawLink reliably latches the arrival reveals and
  // the derived-panel snapshot before the frame is discarded.
  state.packets = state.packets.filter((pk) => (state.simTime - pk.tStartSim) <= pk.durSim * 1.3);
}

// Timestamp annotation colors (match the formula symbol colors).
const TS_PD = '#58a6ff';   // Pdelay handshake t₁–t₄
const TS_SY = '#a371f7';   // Sync t₁ / t₂
const TS_C  = '#d29922';   // correctionField c
const TS_DP = '#f85149';   // poll notify delay Δp

// One dedicated lane per gPTP frame type (top → bottom), each with its own
// color, direction and short label. dir 1 = master→slave, dir -1 = slave→master.
const FRAME_LANES = [
  { type: 'Sync',                   label: 'Sync',        dir: 1,  color: '#58a6ff' },
  { type: 'Follow_Up',              label: 'Follow_Up',   dir: 1,  color: '#79c0ff' },
  { type: 'Pdelay_Req',             label: 'Pdelay_Req',  dir: -1, color: '#f0b429' },
  { type: 'Pdelay_Resp',            label: 'Pdelay_Resp', dir: 1,  color: '#3fb950' },
  { type: 'Pdelay_Resp_Follow_Up',  label: 'Pd_Resp_FUp', dir: 1,  color: '#56d4b8' },
];

// Lanes actually shown depend on the configured mode: Follow_Up only in
// two-step; the three Pdelay lanes only when the peer-delay handshake is on.
function activeLanes() {
  return FRAME_LANES.filter((ln) => {
    if (ln.type === 'Follow_Up') return cfg.stepMode === 2;
    if (ln.type.startsWith('Pdelay')) return !!cfg.pdelayEn;
    return true;
  });
}

function drawLink() {
  const w = els.linkCanvas._w, h = els.linkCanvas._h;
  const procW = 54;              // slave RX-processing zone (port → STBM calc)
  const x0 = 74, x1 = w - 12 - procW;   // x1 = slave PORT (Rx/Tx at the wire)
  const stbmX = w - 12;          // where the slave STBM makes the calculation
  linkCtx.clearRect(0, 0, w, h);
  linkCtx.font = '10.5px Consolas, monospace';

  // Compute a y position for each frame-type lane.
  const padT = 16, padB = 14;
  const lanes = activeLanes();
  const n = lanes.length;
  const laneY = (i) => padT + (i + 0.5) * ((h - padT - padB) / n);
  const yOf = {};
  lanes.forEach((ln, i) => { yOf[ln.type] = laneY(i); });

  // endpoint captions: master, the slave PORT (wire), and the STBM calc point
  linkCtx.fillStyle = '#5f6b7c';
  linkCtx.textAlign = 'left';
  linkCtx.fillText('MASTER', 4, 10);
  linkCtx.textAlign = 'center';
  linkCtx.fillText('SLAVE PORT', x1, 10);
  linkCtx.textAlign = 'right';
  linkCtx.fillText('STBM', w - 2, 10);

  // vertical guide marking the slave port (where Rx/Tx timestamps are captured)
  linkCtx.strokeStyle = '#232c3a';
  linkCtx.setLineDash([2, 3]);
  linkCtx.lineWidth = 1;
  linkCtx.beginPath();
  linkCtx.moveTo(x1, padT - 4); linkCtx.lineTo(x1, h - padB + 4); linkCtx.stroke();
  linkCtx.setLineDash([]);

  // draw each lane: label + directional line + arrowhead
  lanes.forEach((ln, i) => {
    const y = laneY(i);
    // lane label (left, colored)
    linkCtx.fillStyle = ln.color;
    linkCtx.textAlign = 'left';
    linkCtx.fillText(ln.label, 4, y - 4);

    // baseline
    linkCtx.strokeStyle = '#1e2634';
    linkCtx.lineWidth = 1.5;
    linkCtx.beginPath();
    linkCtx.moveTo(x0, y); linkCtx.lineTo(x1, y); linkCtx.stroke();

    // arrow head pointing in the frame's travel direction
    linkCtx.fillStyle = '#2b3444';
    const ax = ln.dir === 1 ? x1 : x0;
    linkCtx.beginPath();
    linkCtx.moveTo(ax, y);
    linkCtx.lineTo(ax - ln.dir * 8, y - 4);
    linkCtx.lineTo(ax - ln.dir * 8, y + 4);
    linkCtx.fill();

    // Slave RX processing path — a small 2nd leg from the port to the STBM
    // calc point, shown on every lane. The leg length represents the poll
    // notify / RX processing delay Δp between the port timestamp and when the
    // slave STBM consumes the frame.
    {
      linkCtx.strokeStyle = TS_DP;
      linkCtx.setLineDash([3, 3]);
      linkCtx.lineWidth = 1.3;
      linkCtx.beginPath();
      linkCtx.moveTo(x1, y); linkCtx.lineTo(stbmX, y); linkCtx.stroke();
      linkCtx.setLineDash([]);
      // STBM calc node at the end of the processing leg
      linkCtx.fillStyle = '#151b26';
      linkCtx.strokeStyle = TS_DP;
      linkCtx.lineWidth = 1.3;
      linkCtx.beginPath();
      linkCtx.rect(stbmX - 3, y - 4, 6, 8);
      linkCtx.fill(); linkCtx.stroke();
      // Δp tag above the leg
      linkCtx.fillStyle = TS_DP;
      linkCtx.font = '9px Consolas, monospace';
      linkCtx.textAlign = 'center';
      linkCtx.fillText('Δp', (x1 + stbmX) / 2, y - 5);
      linkCtx.font = '10.5px Consolas, monospace';
      linkCtx.textAlign = 'left';
    }
  });

  // moving frames, each animated along its own lane (progress in sim time)
  for (const pk of state.packets) {
    const p = (state.simTime - pk.tStartSim) / pk.durSim;
    // Latch timestamp reveals as the packet passes their progress point, and
    // the derived-panel snapshot once it arrives — so on-diagram values and
    // computed results stay locked to the animation, even while pipelined.
    if (pk.reveals && p >= 0) {
      let latched = false;
      for (const rv of pk.reveals) {
        if (p >= rv.p) {
          state.tsLabels[rv.key] = { sym: rv.sym, color: rv.color, val: rv.val };
          // Feed the incremental slave calculation as each term is revealed.
          if (rv.calc && !(rv.calc.f in state.syPartial)) {
            state.syPartial[rv.calc.f] = rv.calc.v;
            latched = true;
          }
        }
      }
      if (latched) updateComputePanels();
    }
    if (pk.snap && !pk.arrived && p >= 1) {
      pk.arrived = true;
      if (pk.snap.kind === 'sync') state.lastSyncReady = pk.snap.data;
      else if (pk.snap.kind === 'pdelay') state.lastPdelayReady = pk.snap.data;
      updateComputePanels();
    }
    // After a frame reaches the slave port, animate a dot along the RX
    // processing leg (port → STBM) to depict the poll notify / processing
    // delay Δp. Applies to every frame that arrives at the slave (dir === 1).
    if (pk.dir === 1 && p > 1 && p <= 1.3) {
      const pp = (p - 1) / 0.3;                 // 0..1 along the processing leg
      const px = x1 + pp * (stbmX - x1);
      const py = yOf[pk.type];
      if (py != null) {
        linkCtx.fillStyle = TS_DP;
        linkCtx.beginPath(); linkCtx.arc(px, py, 3, 0, Math.PI * 2); linkCtx.fill();
      }
    }
    if (p < 0 || p > 1.05) continue;
    const y = yOf[pk.type];
    if (y == null) continue;
    const x = pk.dir === 1 ? x0 + p * (x1 - x0) : x1 - p * (x1 - x0);
    // glow
    const grad = linkCtx.createRadialGradient(x, y, 0, x, y, 9);
    grad.addColorStop(0, pk.color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    linkCtx.fillStyle = grad;
    linkCtx.beginPath(); linkCtx.arc(x, y, 9, 0, Math.PI * 2); linkCtx.fill();
    // core
    linkCtx.fillStyle = pk.color;
    linkCtx.beginPath(); linkCtx.arc(x, y, 4, 0, Math.PI * 2); linkCtx.fill();
  }

  // ---- HW timestamp annotations at each arrow endpoint ----
  // Draw the latched "symbol value" label just inside an endpoint (side 'L' =
  // master, 'R' = slave). Values are latched by the animation as each frame
  // reaches the endpoint that captures them.
  const drawEndTs = (key, side, row) => {
    const lbl = state.tsLabels[key];
    if (!lbl) return;
    // 'SyncC' is a virtual second row of labels drawn on the Sync lane (used in
    // one-step mode, where the correctionField c and Δp ride the Sync frame).
    const rawType = key.split(':')[0];
    const laneType = rawType === 'SyncC' ? 'Sync' : rawType;
    const y = yOf[laneType];
    if (y == null) return;
    linkCtx.font = '10.5px Consolas, monospace';
    const yy = y + 12 + (row || 0) * 11;      // sit just below the lane line
    const symStr = lbl.sym + ' ';
    const symW = linkCtx.measureText(symStr).width;
    const valW = linkCtx.measureText(lbl.val).width;
    let sx;
    if (side === 'L') { sx = x0 + 3; }
    else { sx = x1 - 3 - symW - valW; }
    linkCtx.textAlign = 'left';
    linkCtx.fillStyle = lbl.color;
    linkCtx.fillText(symStr, sx, yy);
    linkCtx.fillStyle = '#8b98a9';
    linkCtx.fillText(lbl.val, sx + symW, yy);
  };
  drawEndTs('Sync:L', 'L');                 // t₁ preciseOriginTimestamp (master egress)
  drawEndTs('Sync:R', 'R');                 // t₂ Sync ingress (slave)
  if (cfg.stepMode === 1) {
    drawEndTs('SyncC:L', 'L', 1);           // c correctionField on Sync lane (one-step)
    drawEndTs('SyncC:R', 'R', 1);           // Δp poll notify delay on Sync lane (one-step)
  } else {
    drawEndTs('Follow_Up:L', 'L');          // c correctionField (master egress)
    drawEndTs('Follow_Up:R', 'R');          // Δp poll notify delay (slave)
  }
  if (cfg.pdelayEn) {
    drawEndTs('Pdelay_Req:R', 'R');           // t₁ Pdelay_Req egress (slave)
    drawEndTs('Pdelay_Req:L', 'L');           // t₂ Pdelay_Req ingress (master)
    drawEndTs('Pdelay_Resp:L', 'L');          // t₃ Pdelay_Resp egress (master)
    drawEndTs('Pdelay_Resp:R', 'R');          // t₄ Pdelay_Resp ingress (slave)
  }

  linkCtx.textAlign = 'left';
}

/* ---------------- Timestamp value graph (counting-up timers) ---------------- */
function drawTimers() {
  const W = els.timerCanvas._w, H = els.timerCanvas._h;
  const padL = 78, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  timerCtx.clearRect(0, 0, W, H);

  const hist = state.history || [];
  const now = state.simTime || cfg.startMs;
  const windowMs = view.spanMs;
  const tMin = Math.max(cfg.startMs, now - windowMs);
  const tMax = Math.max(tMin + windowMs, now);

  // raw counting-up timer values (ms) for each history point
  const rawM = (p) => cfg.epoch + (p.t - cfg.startMs) + p.mOff;
  const rawS = (p) => cfg.epoch + (p.t - cfg.startMs) + p.sOff;
  const rawRx = (p) => (p.rxOff == null ? null : cfg.epoch + (p.t - cfg.startMs) + p.rxOff);

  let yMin = Infinity, yMax = -Infinity;
  for (const p of hist) {
    if (p.t < tMin) continue;
    yMin = Math.min(yMin, rawM(p), rawS(p));
    yMax = Math.max(yMax, rawM(p), rawS(p));
  }
  if (!isFinite(yMin)) { yMin = cfg.epoch; yMax = cfg.epoch + windowMs; }
  if (yMax - yMin < 1) yMax = yMin + 1;
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad; yMax += yPad;

  const X = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const Y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // horizontal grid with raw ms labels
  timerCtx.font = '11px Consolas, monospace';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) / 4) * i;
    const y = Y(v);
    timerCtx.strokeStyle = '#161d2a';
    timerCtx.lineWidth = 1;
    timerCtx.beginPath(); timerCtx.moveTo(padL, y); timerCtx.lineTo(W - padR, y); timerCtx.stroke();
    timerCtx.fillStyle = '#5f6b7c';
    timerCtx.fillText(`${Math.round(v).toLocaleString()}`, 4, y + 3);
  }
  timerCtx.save();
  timerCtx.fillStyle = '#5f6b7c';
  timerCtx.translate(12, padT + plotH / 2);
  timerCtx.rotate(-Math.PI / 2);
  timerCtx.textAlign = 'center';
  timerCtx.fillText('timer value (ms)', 0, 0);
  timerCtx.restore();

  // vertical 25 ms sampling divisions + time scale
  drawTimeAxis(timerCtx, tMin, tMax, X, padT, plotH, padL, padR, W, H, HISTORY_SAMPLE_MS);

  const drawTimer = (fn, color) => {
    timerCtx.strokeStyle = color;
    timerCtx.lineWidth = 2;
    timerCtx.beginPath();
    let started = false;
    for (const p of hist) {
      if (p.t < tMin) continue;
      const y = Y(fn(p));
      if (!started) { timerCtx.moveTo(X(p.t), y); started = true; }
      else timerCtx.lineTo(X(p.t), y);
    }
    timerCtx.stroke();
  };
  drawTimer(rawM, '#f0b429');   // master timer
  drawTimer(rawS, '#3fb950');   // slave timer

  // received-master timestamp (from Sync/Follow_Up), held as a staircase.
  timerCtx.strokeStyle = 'rgba(88,166,255,.85)';
  timerCtx.setLineDash([4, 3]);
  timerCtx.lineWidth = 1.5;
  timerCtx.beginPath();
  let rxStarted = false, prevY = null;
  for (const p of hist) {
    if (p.t < tMin) continue;
    const v = rawRx(p);
    if (v == null) { rxStarted = false; continue; }
    const y = Y(v), x = X(p.t);
    if (!rxStarted) { timerCtx.moveTo(x, y); rxStarted = true; }
    else { timerCtx.lineTo(x, prevY); timerCtx.lineTo(x, y); }   // step
    prevY = y;
  }
  timerCtx.stroke();
  timerCtx.setLineDash([]);

  // sync markers on the slave timer
  for (const ev of state.events) {
    if (ev.t < tMin || ev.sOff === undefined) continue;
    const raw = cfg.epoch + (ev.t - cfg.startMs) + ev.sOff;
    const x = X(ev.t), y = Y(raw);
    if (y < padT || y > padT + plotH) continue;
    timerCtx.fillStyle = ev.type === 'rej' ? '#f85149' : (ev.type === 'init' ? '#58a6ff' : '#3fb950');
    timerCtx.beginPath(); timerCtx.arc(x, y, 4, 0, Math.PI * 2); timerCtx.fill();
    if (ev.type === 'rej') {
      timerCtx.strokeStyle = '#f85149'; timerCtx.lineWidth = 1.5;
      timerCtx.beginPath();
      timerCtx.moveTo(x - 5, y - 5); timerCtx.lineTo(x + 5, y + 5);
      timerCtx.moveTo(x + 5, y - 5); timerCtx.lineTo(x - 5, y + 5);
      timerCtx.stroke();
    }
  }

  // live value readout
  if (hist.length) {
    const last = hist[hist.length - 1];
    timerCtx.textAlign = 'right';
    timerCtx.fillStyle = '#f0b429';
    timerCtx.fillText(`M ${Math.round(rawM(last)).toLocaleString()} ms`, W - padR, padT + 12);
    timerCtx.fillStyle = '#3fb950';
    timerCtx.fillText(`S ${Math.round(rawS(last)).toLocaleString()} ms`, W - padR, padT + 26);
    timerCtx.textAlign = 'left';
  }
}

/* ---------------- Graph ---------------- */
// Shared x-axis: vertical divisions, labelled with absolute sim time (ms).
// baseDiv sets the desired grid step (defaults to the Sync period).
function drawTimeAxis(ctx, tMin, tMax, X, padT, plotH, padL, padR, W, H, baseDiv) {
  const base = baseDiv || cfg.syncInterval;
  const span = tMax - tMin;
  let div = base;
  while (span / div > 16) div *= 2;      // keep the grid readable
  const first = Math.ceil(tMin / div) * div;
  ctx.save();
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'center';
  for (let t = first; t <= tMax + 1e-6; t += div) {
    const x = X(t);
    ctx.strokeStyle = 'rgba(88,166,255,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.fillStyle = '#6b7891';
    ctx.fillText(`${Math.round(t)}`, x, H - 8);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#5f6b7c';
  const note = div === base
    ? `grid = ${base} ms`
    : `grid = ${div} ms (${Math.round(div / base)}× ${base} ms)`;
  ctx.fillText(`time (ms) — ${note}`, padL, padT + 10);
  ctx.restore();
}

function drawGraph() {
  const W = els.graphCanvas._w, H = els.graphCanvas._h;
  const padL = 54, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  graphCtx.clearRect(0, 0, W, H);

  const hist = state.history || [];
  const now = state.simTime || cfg.startMs;
  const windowMs = view.spanMs;
  const tMin = Math.max(cfg.startMs, now - windowMs);
  const tMax = Math.max(tMin + windowMs, now);

  // dynamic y-range
  let yMax = 1;
  for (const p of hist) if (p.t >= tMin) yMax = Math.max(yMax, Math.abs(p.dev) * 1.2, 1);
  yMax = Math.max(yMax, (cfg.accuracyUs / 1000) * 4);

  const X = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const Y = (d) => padT + plotH / 2 - (d / yMax) * (plotH / 2);

  // grid + zero axis
  graphCtx.strokeStyle = '#1c2330';
  graphCtx.lineWidth = 1;
  graphCtx.fillStyle = '#5f6b7c';
  graphCtx.font = '11px Consolas, monospace';
  for (let i = -2; i <= 2; i++) {
    const d = (yMax / 2) * i;
    const y = Y(d);
    graphCtx.strokeStyle = i === 0 ? '#33405a' : '#161d2a';
    graphCtx.beginPath(); graphCtx.moveTo(padL, y); graphCtx.lineTo(W - padR, y); graphCtx.stroke();
    graphCtx.fillText(`${d.toFixed(1)} ms`, 6, y + 3);
  }

  // vertical Sync-period divisions + time scale
  drawTimeAxis(graphCtx, tMin, tMax, X, padT, plotH, padL, padR, W, H);

  // ±accuracy band
  const acc = cfg.accuracyUs / 1000;
  graphCtx.fillStyle = 'rgba(88,166,255,.14)';
  graphCtx.fillRect(padL, Y(acc), plotW, Y(-acc) - Y(acc));

  // 6.25% plausibility envelope
  graphCtx.strokeStyle = 'rgba(163,113,247,.85)';
  graphCtx.setLineDash([5, 4]);
  graphCtx.lineWidth = 1.5;
  for (const sign of [1, -1]) {
    graphCtx.beginPath();
    let started = false;
    for (const p of hist) {
      if (p.t < tMin || !isFinite(p.env)) { started = false; continue; }
      const y = Y(sign * Math.min(p.env, yMax * 1.5));
      if (!started) { graphCtx.moveTo(X(p.t), y); started = true; }
      else graphCtx.lineTo(X(p.t), y);
    }
    graphCtx.stroke();
  }
  graphCtx.setLineDash([]);

  // deviation line
  graphCtx.strokeStyle = '#3fb950';
  graphCtx.lineWidth = 2;
  graphCtx.beginPath();
  let started = false;
  for (const p of hist) {
    if (p.t < tMin) continue;
    const y = Y(Math.max(-yMax * 1.5, Math.min(yMax * 1.5, p.dev)));
    if (!started) { graphCtx.moveTo(X(p.t), y); started = true; }
    else graphCtx.lineTo(X(p.t), y);
  }
  graphCtx.stroke();

  // sync event markers
  for (const ev of state.events) {
    if (ev.t < tMin) continue;
    const x = X(ev.t), y = Y(Math.max(-yMax * 1.5, Math.min(yMax * 1.5, ev.dev)));
    graphCtx.fillStyle = ev.type === 'rej' ? '#f85149' : (ev.type === 'init' ? '#58a6ff' : '#3fb950');
    graphCtx.beginPath();
    graphCtx.arc(x, y, 4, 0, Math.PI * 2);
    graphCtx.fill();
    if (ev.type === 'rej') {
      graphCtx.strokeStyle = '#f85149';
      graphCtx.beginPath();
      graphCtx.moveTo(x - 5, y - 5); graphCtx.lineTo(x + 5, y + 5);
      graphCtx.moveTo(x + 5, y - 5); graphCtx.lineTo(x - 5, y + 5);
      graphCtx.stroke();
    }
  }
}

/* ---------------- Timer-count graph ----------------
 * Raw free-running oscillator tick counts vs time. count = freq(kHz) ×
 * elapsed(ms). The SLOPE of each line equals the clock frequency, so two
 * clocks of the same frequency draw parallel/overlapping lines, and a
 * frequency difference shows as a growing gap (divergent slopes).
 */
function drawClocks() {
  const W = els.clockCanvas._w, H = els.clockCanvas._h;
  const padL = 92, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  clockCtx.clearRect(0, 0, W, H);

  const hist = state.history || [];
  const now = state.simTime || cfg.startMs;
  const windowMs = view.spanMs;
  const tMin = Math.max(cfg.startMs, now - windowMs);
  const tMax = Math.max(tMin + windowMs, now);

  // tick counts (freq in kHz = ticks per ms)
  const mCount = (t) => cfg.masterFreq * (t - cfg.startMs);
  const sCount = (t) => cfg.slaveFreq * (t - cfg.startMs);

  const yLo = Math.min(mCount(tMin), sCount(tMin));
  const yHi = Math.max(mCount(tMax), sCount(tMax));
  const yMin = yLo, yMax = Math.max(yHi, yLo + 1);

  const X = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const Y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // horizontal grid with tick-count labels
  clockCtx.font = '11px Consolas, monospace';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) / 4) * i;
    const y = Y(v);
    clockCtx.strokeStyle = '#161d2a';
    clockCtx.lineWidth = 1;
    clockCtx.beginPath(); clockCtx.moveTo(padL, y); clockCtx.lineTo(W - padR, y); clockCtx.stroke();
    clockCtx.fillStyle = '#5f6b7c';
    clockCtx.fillText(`${Math.round(v).toLocaleString()}`, 4, y + 3);
  }
  clockCtx.save();
  clockCtx.fillStyle = '#5f6b7c';
  clockCtx.translate(12, padT + plotH / 2);
  clockCtx.rotate(-Math.PI / 2);
  clockCtx.textAlign = 'center';
  clockCtx.fillText('timer count (ticks)', 0, 0);
  clockCtx.restore();

  // vertical time divisions
  drawTimeAxis(clockCtx, tMin, tMax, X, padT, plotH, padL, padR, W, H, HISTORY_SAMPLE_MS);

  const drawLine = (fn, color) => {
    clockCtx.strokeStyle = color;
    clockCtx.lineWidth = 2.5;
    clockCtx.beginPath();
    clockCtx.moveTo(X(tMin), Y(fn(tMin)));
    clockCtx.lineTo(X(tMax), Y(fn(tMax)));
    clockCtx.stroke();
  };
  drawLine(mCount, '#f0b429');   // master timer count
  drawLine(sCount, '#3fb950');   // slave timer count

  // slope + divergence readout
  const gap = sCount(now) - mCount(now);
  clockCtx.textAlign = 'right';
  clockCtx.fillStyle = '#f0b429';
  clockCtx.fillText(`master slope = ${cfg.masterFreq} kticks/s`, W - padR, padT + 12);
  clockCtx.fillStyle = '#3fb950';
  clockCtx.fillText(`slave slope = ${cfg.slaveFreq} kticks/s`, W - padR, padT + 26);
  clockCtx.fillStyle = Math.abs(gap) < 1 ? '#5f6b7c' : '#f85149';
  clockCtx.fillText(`slave − master = ${gap >= 0 ? '+' : ''}${Math.round(gap).toLocaleString()} ticks`, W - padR, padT + 40);
  clockCtx.textAlign = 'left';
}

/* ---------------- Readouts ---------------- */
function fmtHuman(ms) {
  const v = ((ms % CLOCK_MOD) + CLOCK_MOD) % CLOCK_MOD;
  const totalSec = v / 1000;
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor(totalSec / 60) % 60;
  const s = Math.floor(totalSec) % 60;
  const msec = Math.floor(v % 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(msec).padStart(3,'0')}`;
}
function fmtSigned(x) { return (x >= 0 ? '+' : '') + x.toFixed(3) + ' ms'; }

// Pick µs or ms based on magnitude; keeps signed sense.
function fmtAuto(ms, signed) {
  const s = signed ? (ms >= 0 ? '+' : '') : '';
  if (Math.abs(ms) < 1) return `${s}${(ms * 1000).toFixed(2)} µs`;
  return `${s}${ms.toFixed(3)} ms`;
}
// Absolute timestamp with µs precision, shown as ms.
function fmtTs(ms) {
  return `${ms.toFixed(6)} ms`;
}

/* ---------------- Mode-dependent UI (step mode + Pdelay) ---------------- */
// Reflects the configured timestamping mode in the static UI: which frame
// lanes/legend entries are relevant, which HW-timestamp rows apply, the link
// caption, and whether the peer-delay (δ) block and formula term are active.
function updateModeUI() {
  const pdOn = !!cfg.pdelayEn;
  const twoStep = cfg.stepMode === 2;

  // Frame legend — hide entries for lanes that are not exchanged in this mode.
  if (els.frameLegend) {
    els.frameLegend.querySelectorAll('span[data-lane]').forEach((sp) => {
      const lane = sp.getAttribute('data-lane');
      let show = true;
      if (lane === 'Follow_Up') show = twoStep;
      else if (lane.indexOf('Pdelay') === 0) show = pdOn;
      sp.style.display = show ? '' : 'none';
    });
  }

  // HW-timestamp legend rows that only exist when Pdelay runs (t₁/t₄ slave,
  // t₂/t₃ master).
  document.querySelectorAll('.ts-key-row.pd-only').forEach((row) => {
    row.style.display = pdOn ? '' : 'none';
  });

  // Link caption + master t₁ description reflect one/two-step behaviour.
  if (els.linkLabel) {
    els.linkLabel.innerHTML =
      `IEEE 802.1AS gPTP · ${twoStep ? 'two-step' : 'one-step'}` +
      ` · <span class="who">Rx/Tx at SLAVE PORT; dashed Δp leg = RX processing path to the STBM calc</span>`;
  }
  if (els.mkT1desc) {
    els.mkT1desc.textContent = twoStep
      ? 'preciseOriginTimestamp — Follow_Up carries it (Sync egress)'
      : 'preciseOriginTimestamp — in Sync frame (one-step egress)';
  }

  // Peer-path-delay calc block: grayed/disabled when Pdelay is off.
  if (els.pdBlock) els.pdBlock.classList.toggle('calc-disabled', !pdOn);
  if (els.pdBlockHead) els.pdBlockHead.classList.toggle('calc-disabled', !pdOn);
  if (!pdOn && els.pdResult) {
    els.pdVals.innerHTML = `<div class="calc-comment">— Pdelay disabled — meanPathDelay δ assumed 0;<br>static ${cfg.staticPathUs} µs link delay left uncompensated</div>`;
    els.pdResult.innerHTML = `<div class="calc-final"><span class="t-mpd">δ</span> = <span class="who">0 µs</span></div>`;
    if (els.pdAt) els.pdAt.textContent = '';
  }

  // δ term in the offset formula only present when Pdelay compensates it.
  if (els.fDelta) els.fDelta.style.display = pdOn ? '' : 'none';
}

/* ---------------- gPTP computation panels ---------------- */
function updateComputePanels() {
  const pd = state.lastPdelayReady;
  // The peer-path-delay block is only meaningful when Pdelay runs; when it does
  // we always render the t₁…t₄ rows (with — placeholders until the first
  // handshake completes) so the structure is visible from the start.
  if (cfg.pdelayEn) {
    const pv = (v) => (pd ? `${v.toFixed(6)} ms` : '<span class="who">—</span>');
    els.pdAt.textContent = pd ? `@ ${Math.round(pd.at)} ms` : '';
    els.pdVals.innerHTML =
      `<div><span class="t-pd">t₁</span> = ${pv(pd && pd.t1)}</div>` +
      `<div><span class="t-pd">t₂</span> = ${pv(pd && pd.t2)}</div>` +
      `<div><span class="t-pd">t₃</span> = ${pv(pd && pd.t3)}</div>` +
      `<div><span class="t-pd">t₄</span> = ${pv(pd && pd.t4)}</div>`;
    if (pd) {
      const rt = (pd.t4 - pd.t1) * 1000;      // round trip µs
      const turn = (pd.t3 - pd.t2) * 1000;    // master turnaround µs
      els.pdResult.innerHTML =
        `<div class="calc-simplified">= ((${rt.toFixed(3)} − ${turn.toFixed(3)}) / 2) µs</div>` +
        `<div class="calc-final"><span class="t-mpd">δ</span> = <span class="ok">${pd.mpdUs.toFixed(3)} µs</span></div>`;
    } else {
      els.pdResult.innerHTML =
        `<div class="calc-simplified">= ((<span class="t-pd">t₄</span> − <span class="t-pd">t₁</span>) − (<span class="t-pd">t₃</span> − <span class="t-pd">t₂</span>)) / 2</div>` +
        `<div class="calc-final"><span class="t-mpd">δ</span> = <span class="who">—</span></div>`;
    }
  }

  // The slave offset block is always rendered. The term rows (t₁, t₂, δ, c, Δp)
  // fill progressively from the Sync currently in flight (state.syPartial),
  // falling back to the last completed Sync's values. The offset / correction /
  // verdict always reflect the most recently COMPLETED Sync (state.lastSyncReady)
  // so they stay visible even while the next Sync is still arriving — this also
  // handles pipelining, where a new Sync departs before the previous Follow_Up
  // has landed (slow frame speed vs. short sync interval).
  const part = state.syPartial || {};
  const sy = state.lastSyncReady;
  const filling = ('at' in part) && (!sy || part.at > sy.at);   // a newer Sync is mid-flight
  const pdelayEn = ('pdelayEn' in part) ? part.pdelayEn : (sy ? sy.pdelayEn : cfg.pdelayEn);
  const hwTs = ('hwTs' in part) ? part.hwTs : (sy ? sy.hwTs : cfg.hwTs);
  els.syAt.textContent = ('at' in part) ? `@ ${Math.round(part.at)} ms` : (sy ? `@ ${Math.round(sy.at)} ms` : '');

  // Per-term value: prefer the in-flight Sync, else the last completed one.
  const term = (field) => (field in part ? part[field] : (sy && field in sy ? sy[field] : undefined));
  const tv = (v, dec, unit, scale = 1) => (v === undefined ? '<span class="who">—</span>' : `${(v * scale).toFixed(dec)} ${unit}`);
  let vals =
    `<div><span class="t-sy">t₁</span> = ${tv(term('t1'), 6, 'ms')}</div>` +
    `<div><span class="t-sy">t₂</span> = ${tv(term('t2'), 6, 'ms')}</div>`;
  if (pdelayEn) vals += `<div><span class="t-mpd">δ</span> = ${tv(term('physMpdMs'), 3, 'µs', 1000)}</div>`;
  vals += `<div><span class="t-c">c</span> = ${tv(term('residenceUs'), 2, 'µs')}</div>`;
  if (!hwTs) vals += `<div><span class="t-dp">Δp</span> = ${tv(term('notifyDelay'), 3, 'ms')}</div>`;
  els.syVals.innerHTML = vals;

  // Simplified formula (symbolic, with active terms).
  const dDelta = pdelayEn ? ` − <span class="t-mpd">δ</span>` : '';
  const dP = hwTs ? '' : ` − <span class="t-dp">Δp</span>`;
  const simplified =
    `<div class="calc-simplified">= <span class="t-sy">t₂</span> − <span class="t-sy">t₁</span>${dDelta} − <span class="t-c">c</span>${dP}</div>`;

  if (sy) {
    // Show the result of the last completed Sync. If a newer Sync is still in
    // flight, add a small note so it's clear which exchange the result is from.
    const cls = sy.inSpec ? 'ok' : 'bad';
    const comments = [];
    if (sy.hwTs) comments.push('Δp not in offset — HW ts');
    if (!sy.pdelayEn) comments.push(`δ assumed 0 — Pdelay off, ${(sy.physMpdMs * 1000).toFixed(0)} µs link delay uncompensated`);
    if (filling) comments.push('next Sync in flight — collecting timestamps…');
    const commentHtml = comments.length
      ? `<div class="calc-comment">${comments.map((c) => `— ${c}`).join('<br>')}</div>`
      : '';
    els.syResult.innerHTML =
      simplified +
      `<div class="calc-final">offset = <span class="${cls}">${fmtAuto(sy.offsetFromMaster, true)}</span> (target ±${cfg.accuracyUs} µs)</div>` +
      commentHtml;

    if (sy.outcome === 'reject') {
      els.syCorrection.textContent = 'correction applied: none (rejected)';
    } else {
      els.syCorrection.innerHTML =
        `correction applied to slave clock: <span class="warn">${fmtAuto(sy.correction, true)}</span>`;
    }

    const verdictText = {
      init: '✓ INITIAL SYNC — clock adopted (was unsynchronized)',
      apply: `✓ SYNC APPLIED — |offset| ${fmtAuto(Math.abs(sy.offsetFromMaster))} < plausibility ±${sy.window.toFixed(2)} ms`,
      reject: `✗ SYNC REJECTED — |offset| ${fmtAuto(Math.abs(sy.offsetFromMaster))} ≥ plausibility ±${sy.window.toFixed(2)} ms → HOLDOVER`,
    }[sy.outcome];
    els.syVerdict.textContent = verdictText;
    els.syVerdict.className = 'verdict ' + sy.outcome;
  } else if ('at' in part) {
    // First Sync is mid-flight — terms are filling; no completed result yet.
    els.syResult.innerHTML =
      simplified +
      `<div class="calc-final">offset = <span class="who">computing…</span> (target ±${cfg.accuracyUs} µs)</div>`;
    els.syCorrection.innerHTML = 'correction applied to slave clock: <span class="who">—</span>';
    els.syVerdict.textContent = 'collecting timestamps…';
    els.syVerdict.className = 'verdict';
  } else {
    // No Sync yet — show the formula skeleton and neutral placeholders.
    els.syResult.innerHTML =
      simplified +
      `<div class="calc-final">offset = <span class="who">—</span> (target ±${cfg.accuracyUs} µs)</div>`;
    els.syCorrection.innerHTML = 'correction applied to slave clock: <span class="who">—</span>';
    els.syVerdict.textContent = 'awaiting first Sync…';
    els.syVerdict.className = 'verdict';
  }
}

/* ---------------- Problem alerts ---------------- */
function updateAlerts() {
  const a = [];
  const devAbs = Math.abs(state.deviation);
  const accMs = cfg.accuracyUs / 1000;

  if (!state.synchronized) {
    a.push(['warn', '◷ UNSYNCHRONIZED — awaiting first sync']);
  } else {
    const holdoverLimit = cfg.syncTimeout > 0 ? cfg.syncTimeout : cfg.syncInterval * 2.5;
    const holdover = (state.simTime - state.lastSyncTime) > holdoverLimit * 0.75;
    if (holdover) a.push(['bad', '⚠ HOLDOVER — syncs rejected (plausibility), awaiting sync-loss timeout']);
    if (devAbs > accMs) a.push(['bad', `⚠ ACCURACY OUT OF SPEC — |dev| ${fmtAuto(devAbs)} > ±${cfg.accuracyUs} µs`]);
    else if (!holdover) a.push(['ok', `✓ In sync — |dev| ${fmtAuto(devAbs)} ≤ ±${cfg.accuracyUs} µs`]);
  }
  if (state.jitter >= JITTER_LIMIT) a.push(['bad', `⚠ CYCLE JITTER HIGH — ${state.jitter.toFixed(3)} ms ≥ 1 ms`]);
  if (cfg.stability > STABILITY_LIMIT) a.push(['warn', `⚠ OSC stability ${cfg.stability}% > 0.1% requirement`]);
  if (state.lastSync && state.lastSync.outcome === 'reject' && (state.simTime - state.lastSync.at) < cfg.syncInterval * 1.5) {
    a.push(['bad', '✗ Last sync rejected (plausibility check failed)']);
  }
  if (state.timeLeap && (state.simTime - state.timeLeapAt) < cfg.syncInterval * 2) {
    const dir = state.lastCorrection >= 0 ? 'forward' : 'backward';
    a.push(['bad', `⚑ STBM timeLeap ${dir} — correction ${fmtSigned(state.lastCorrection)} ≥ ±${cfg.timeLeapMs} ms`]);
  }

  els.alerts.innerHTML = a.map(([cls, txt]) => `<span class="alert ${cls}">${txt}</span>`).join('');
}


function updateReadouts(force) {
  const mt = masterTime();
  const slaveAbs = cfg.epoch + state.slaveClock;

  els.masterHuman.textContent = fmtHuman(mt);
  els.masterRaw.textContent = `${Math.floor(((mt % CLOCK_MOD)+CLOCK_MOD)%CLOCK_MOD).toLocaleString()} ms (32-bit)`;
  els.slaveHuman.textContent = fmtHuman(slaveAbs);
  els.slaveRaw.textContent = `${Math.floor(((slaveAbs % CLOCK_MOD)+CLOCK_MOD)%CLOCK_MOD).toLocaleString()} ms (32-bit)`;

  // STBM synchronized time-base readouts
  if (state.synchronized && state.stbmSyncTime != null) {
    // STBM sync time advances live from the last correction on the slave clock.
    els.stbmTime.textContent = fmtHuman(slaveAbs);
    els.stbmHwTs.textContent = fmtHuman(state.stbmHwTs);
    const nd = state.notifyDelay || 0;
    els.stbmNotify.textContent = `${nd.toFixed(3)} ms`;
    els.stbmNotify.className = 'mono' + (nd > 1 ? ' warn' : '');
    // timeLeap status: latched visually for ~2 sync intervals after it fires.
    const leapRecent = state.timeLeap && (state.simTime - state.timeLeapAt) < cfg.syncInterval * 2;
    if (leapRecent) {
      const dir = state.lastCorrection >= 0 ? '↑ FWD' : '↓ BWD';
      els.stbmLeap.textContent = `⚑ ${dir} ${fmtSigned(state.lastCorrection)}`;
      els.stbmLeap.className = 'mono bad';
    } else {
      els.stbmLeap.textContent = `OK (${fmtSigned(state.lastCorrection)})`;
      els.stbmLeap.className = 'mono';
    }
  } else {
    els.stbmTime.textContent = '—';
    els.stbmHwTs.textContent = '—';
    els.stbmNotify.textContent = '—';
    els.stbmNotify.className = 'mono';
    els.stbmLeap.textContent = '—';
    els.stbmLeap.className = 'mono';
  }

  // slave state tag
  let stateName, stateCls;
  const holdover = state.synchronized && (state.simTime - state.lastSyncTime) > (cfg.syncTimeout > 0 ? cfg.syncTimeout : cfg.syncInterval * 2.5) * 0.75;
  if (!state.synchronized) { stateName = 'UNSYNCHRONIZED'; stateCls = 'state-unsync'; }
  else if (holdover) { stateName = 'HOLDOVER'; stateCls = 'state-holdover'; }
  else { stateName = 'SYNCHRONIZED'; stateCls = 'state-sync'; }
  els.slaveState.textContent = stateName;
  els.slaveState.className = 'node-tag node-tag-inline ' + stateCls;

  // deviation tile
  const dev = state.deviation;
  els.statDev.textContent = fmtSigned(dev);
  els.statDev.className = 'tile-value ' + (Math.abs(dev) <= cfg.accuracyUs/1000 ? 'ok' : (Math.abs(dev) <= 1 ? 'warn' : 'bad'));

  // accuracy tile
  const within = Math.abs(dev) <= cfg.accuracyUs / 1000;
  els.statAcc.textContent = state.synchronized ? (within ? 'IN SPEC' : 'OUT') : '—';
  els.statAcc.className = 'tile-value ' + (!state.synchronized ? '' : (within ? 'ok' : 'bad'));
  els.statAccSub.textContent = `|dev| = ${Math.abs(dev*1000).toFixed(0)} µs`;

  // plausibility window tile
  if (state.synchronized && isFinite(state.lastSyncTime)) {
    const since = state.simTime - state.lastSyncTime;
    const win = PLAUS_FRACTION * since;
    els.statWindow.textContent = `±${win.toFixed(1)} ms`;
    els.statWindowSub.textContent = `${since.toFixed(0)} ms since last sync`;
    els.statWindow.className = 'tile-value ' + (Math.abs(dev) < win ? 'ok' : 'warn');
  } else {
    els.statWindow.textContent = '—';
    els.statWindowSub.textContent = 'not synchronized';
    els.statWindow.className = 'tile-value';
  }

  // jitter tile
  els.statJitter.textContent = state.jitter.toFixed(3) + ' ms';
  els.statJitter.className = 'tile-value ' + (state.jitter < JITTER_LIMIT ? 'ok' : 'bad');

  // sim time
  els.statSimTime.textContent = `${Math.round(state.simTime).toLocaleString()} ms`;
  els.statSyncCount.textContent = `${state.syncCount} syncs`;

  updateAlerts();
  updateComputePanels();
  drawLink();
  drawTimers();
  drawGraph();
  drawClocks();
}

/* ---------------- Node flash + log ---------------- */
function flashNode(kind) {
  const map = { slave: [els.nodeSlave, 'flash-slave'], master: [els.nodeMaster, 'flash-master'], reject: [els.nodeSlave, 'flash-reject'] };
  const [node, cls] = map[kind];
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), 350);

  // record graph event
  const type = kind === 'reject' ? 'rej' : (state.syncCount === 1 ? 'init' : 'ok');
  const nominal = cfg.epoch + (state.simTime - cfg.startMs);
  const sOff = (cfg.epoch + state.slaveClock) - nominal;
  state.events.push({ t: state.simTime, dev: state.deviation, sOff, type });
  if (state.events.length > 400) state.events.shift();
}

function log(cls, tag, msg) {
  const line = document.createElement('div');
  line.className = `log-line lvl-${cls}`;
  line.title = `[${Math.round(state.simTime)} ms] ${msg}`;
  line.innerHTML =
    `<span class="log-time">${Math.round(state.simTime)}</span>` +
    `<span class="log-tag log-${cls}">${tag}</span>`;
  els.log.insertBefore(line, els.log.firstChild);
  while (els.log.childElementCount > 250) els.log.removeChild(els.log.lastChild);
}

/* ---------------- Controls ---------------- */
function start() {
  // Step mode: ▶ advances the sim by exactly one step instead of free-running.
  if (els.cfgStepEn.checked) { doStep(); return; }
  if (state.running) return;
  // Pause -> Start resumes from the current time. A fresh run only happens once
  // the previous run has completed (reached Length) or after an explicit Reset.
  const resume = !state.finished && state.simTime > cfg.startMs;
  if (state.finished) resetState();
  state.running = true;
  state.lastFrame = 0;
  els.btnStart.disabled = true;
  els.btnPause.disabled = false;
  log('info', resume ? 'RESUME' : 'START',
    resume
      ? `Resumed at ${Math.round(state.simTime)} ms`
      : `Simulation started (speed ${cfg.speed}×, sync every ${cfg.syncInterval} ms)`);
  requestAnimationFrame(step);
}

// Advance the simulation by a single fixed step (used by Step mode). Works
// while paused/idle; a finished run is reset first so stepping can restart it.
function doStep() {
  if (state.running) stop();
  if (state.finished) resetState();
  const stepMs = Math.max(1, +els.cfgStep.value || 50);
  advance(stepMs);
  if (cfg.stopMs > 0 && state.simTime >= cfg.stopMs) {
    state.simTime = cfg.stopMs;
    state.finished = true;
    updateReadouts(true);
    log('info', 'STOP', `Simulation stopped at ${Math.round(cfg.stopMs)} ms`);
    return;
  }
  updateReadouts(false);
  log('info', 'STEP', `+${stepMs} ms → ${Math.round(state.simTime)} ms`);
}
function stop() {
  state.running = false;
  els.btnStart.disabled = false;
  els.btnPause.disabled = true;
}
function pause() { stop(); log('info', 'PAUSE', 'Paused'); }

els.btnStart.addEventListener('click', start);
els.btnPause.addEventListener('click', pause);
els.btnReset.addEventListener('click', () => { stop(); resetState(); log('info', 'RESET', 'Reset'); });

// Turning Step mode on halts free-running so ▶ becomes a single-step trigger.
els.cfgStepEn.addEventListener('change', () => {
  if (els.cfgStepEn.checked && state.running) { stop(); log('info', 'STEP', 'Step mode on — ▶ advances one step'); }
});

els.btnToggleConfig.addEventListener('click', () => {
  const hidden = document.querySelector('.main-row').classList.toggle('config-hidden');
  els.btnToggleConfig.classList.toggle('active', !hidden);
});

els.cfgSpeed.addEventListener('input', () => {
  els.outSpeed.textContent = (+els.cfgSpeed.value).toFixed(2) + '×';
  if (state.running) cfg.speed = +els.cfgSpeed.value;
});

// Frame animation speed (visual only, decoupled from sim speed)
els.cfgFrameSpeed.addEventListener('input', () => {
  view.frameSpeed = +els.cfgFrameSpeed.value;
  els.outFrameSpeed.textContent = view.frameSpeed.toFixed(2) + '×';
});

// Time-view zoom
function fmtSpan(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1) + ' s';
  return Math.round(ms) + ' ms';
}
function applyZoom() {
  view.spanMs = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.spanMs));
  els.outZoom.textContent = fmtSpan(view.spanMs);
  if (!state.running) { drawTimers(); drawGraph(); drawClocks(); }
}
els.btnZoomIn.addEventListener('click', () => { view.spanMs /= 2; applyZoom(); });
els.btnZoomOut.addEventListener('click', () => { view.spanMs *= 2; applyZoom(); });

// Live-apply config that is safe to change mid-run
['cfgMasterFreq','cfgSyncInterval','cfgTimeShift','cfgSlaveFreq','cfgStability','cfgCycle','cfgAccuracy','cfgPdelay','cfgStaticPath','cfgNoise','cfgSyncJitter','cfgPollPeriod','cfgBusMax','cfgSyncTimeout','cfgTimeLeap','cfgAcceptAll']
  .forEach((id) => els[id].addEventListener('change', () => { if (state.running) readConfig(); }));

// Timestamping mode (1/2-step) and Pdelay enable change which frames run, the
// active lanes/legend, the HW-timestamp rows and the offset formula. Apply
// immediately (running or not) and drop in-flight frames/labels from the old
// mode so nothing stale lingers on the diagram.
['cfgStepMode','cfgPdelayEn'].forEach((id) => els[id].addEventListener('change', () => {
  readConfig();
  state.packets = [];
  state.tsLabels = {};
  updateModeUI();
  updateComputePanels();
  if (!state.running) { drawLink(); }
  log('info', 'MODE', `${cfg.stepMode}-step, Pdelay ${cfg.pdelayEn ? 'ON' : 'OFF'}`);
}));

// RX timestamping method (HW/SW) — the header select and the sidebar
// "Ethernet HW timestamping" checkbox are two views of the same setting; keep
// them in sync (cfgHwTs is the source of truth read by readConfig).
function syncTsControls(fromHeader) {
  if (fromHeader) els.cfgHwTs.checked = (els.cfgTsMode.value === 'hw');
  else els.cfgTsMode.value = els.cfgHwTs.checked ? 'hw' : 'sw';
}
els.cfgTsMode.addEventListener('change', () => {
  syncTsControls(true);
  readConfig();
  updateModeUI();
  updateComputePanels();
  log('info', 'TS', `RX timestamping: ${cfg.hwTs ? 'HW' : 'SW'}`);
});
els.cfgHwTs.addEventListener('change', () => {
  syncTsControls(false);
  readConfig();
  updateModeUI();
  updateComputePanels();
});

// Bus traffic load slider (affects variable RX notify delay)
els.cfgBusLoad.addEventListener('input', () => {
  els.outBusLoad.textContent = els.cfgBusLoad.value + '%';
  if (state.running) cfg.busLoad = (+els.cfgBusLoad.value) / 100;
});

// Update derived ppm readouts live as frequencies are typed
['cfgMasterFreq','cfgSlaveFreq'].forEach((id) => els[id].addEventListener('input', () => {
  cfg.masterFreq = Math.max(1, +els.cfgMasterFreq.value);
  cfg.slaveFreq = Math.max(1, +els.cfgSlaveFreq.value);
  updateFreqReadouts();
}));

// Freeze toggle applies live and logs the transition
els.cfgFreeze.addEventListener('change', () => {
  cfg.freeze = els.cfgFreeze.checked;
  log(cfg.freeze ? 'warn' : 'info', cfg.freeze ? 'Slave clock FROZEN (counting stopped)' : 'Slave clock resumed');
});

// Changing timing base while stopped rebuilds the run
['cfgStop','cfgEpoch'].forEach((id) =>
  els[id].addEventListener('change', () => { if (!state.running) resetState(); }));

/* ---------------- Init ---------------- */
els.outSpeed.textContent = (+els.cfgSpeed.value).toFixed(2) + '×';
view.frameSpeed = +els.cfgFrameSpeed.value;
els.outFrameSpeed.textContent = view.frameSpeed.toFixed(2) + '×';
els.outZoom.textContent = fmtSpan(view.spanMs);
els.outBusLoad.textContent = els.cfgBusLoad.value + '%';
syncTsControls(false);           // reflect the sidebar HW-timestamp default in the header select
readConfig();
updateModeUI();
resetState();
log('info', 'READY', 'Ready. Configure parameters and press Start.');
