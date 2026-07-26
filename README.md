# gPTP / STBM Time Synchronization Visualizer

[![Live Demo](https://img.shields.io/badge/Live%20Demo-online-3fb950?style=flat)](https://rudupa.github.io/EthTimeSync_Sim/)
[![Docs](https://img.shields.io/badge/Docs-explainer-58a6ff?style=flat)](https://rudupa.github.io/EthTimeSync_Sim/docs.html)
[![License: MIT](https://img.shields.io/badge/License-MIT-a371f7?style=flat)](LICENSE)
![Vanilla JS](https://img.shields.io/badge/Built%20with-Vanilla%20JS%20%2B%20Canvas-d29922?style=flat)
[![Stars](https://img.shields.io/github/stars/rudupa/EthTimeSync_Sim?style=flat)](https://github.com/rudupa/EthTimeSync_Sim/stargazers)

> **▶ [Try the live demo](https://rudupa.github.io/EthTimeSync_Sim/)** — no install, runs entirely in your browser.

https://github.com/rudupa/EthTimeSync_Sim/raw/main/Demo_1920x1080.mp4

An interactive, single-page visualization of automotive/TSN time synchronization:
**gPTP (IEEE 802.1AS)** offset correction and the **AUTOSAR STBM** (Synchronized
Time-Base Manager). Built with vanilla HTML/CSS/JavaScript and HTML5 Canvas — no
build step, no dependencies.

## Features

- Master (Grandmaster) → Slave synchronization with a live link/frame animation.
- Sync / Follow_Up offset measurement and the Pdelay peer-delay handshake.
- Configurable modes: **1-step vs 2-step**, **HW vs SW timestamping**, and
  **with/without Pdelay**.
- Slave offset calculation panel that fills in each timestamp as it becomes
  available (t₁, t₂, δ, c, Δp) and computes the offset once all terms arrive.
- STBM behavior: plausibility window, holdover, and timeLeap notifications.
- Step mode to advance the simulation one fixed step at a time.
- A detailed explainer page ([open the docs](https://rudupa.github.io/EthTimeSync_Sim/docs.html)) covering every term and mode
  with worked numeric examples.

## Roadmap — planned improvements

Ranked by fidelity impact for a faithful master ↔ slave synchronization:

**Core sync accuracy**
- [x] **Frequency correction / syntonization** *(implemented)* — a PI clock servo
  that disciplines the slave *oscillator rate* (not just phase), with
  acquiring → locked states. Turns the deviation curve from a sawtooth into a
  converging, flat line. Toggle it with the **Correction mode** control
  (*Phase + frequency (servo)* vs. *Phase only (step)*) in the slave clock panel.
- [x] **rateRatio / neighborRateRatio** *(implemented)* — measures the
  master-to-slave frequency ratio from successive Sync HW timestamps and shows
  it (plus the live `rateCorr` in ppm and LOCKED/acquiring state) in the
  **rateRatio** tile; the value feeds the frequency servo.
- [ ] **Link delay asymmetry correction** (`delayAsymmetry`) — model TX ≠ RX path
  delay instead of assuming a perfectly symmetric link.

**Network realism**
- [ ] **Multi-hop / bridges (transparent clocks)** — relay nodes accumulating
  residence time and rateRatio into the correctionField.
- [ ] **BMCA + Announce messages** — elect the grandmaster (clockClass/priority/
  accuracy) and handle GM failover / topology change.
- [ ] **Message loss / sequenceId / out-of-order** — detect dropped or reordered
  Sync/Follow_Up/Pdelay frames and degrade gracefully.

**Completeness**
- [ ] **UTC/TAI offset + leap-second flags** (`currentUtcOffset`, leap59/61).
- [ ] **Multiple gPTP domains** (802.1AS-2020 working clock vs. global time).
- [ ] **Temperature-dependent oscillator drift** and **Pdelay filtering**
  (median/averaging of δ).

## Run it

**▶ [Open the live app on GitHub Pages](https://rudupa.github.io/EthTimeSync_Sim/)** — nothing to install or build.

Prefer the deep-dive? **[Read the explainer](https://rudupa.github.io/EthTimeSync_Sim/docs.html)**.

To run locally, just open `index.html` in a browser.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The interactive simulator page. |
| `docs.html`  | Detailed explanation of how gPTP / STBM synchronization works. |
| `styles.css` | Shared dark-theme styling. |
| `sim.js`     | Simulation model, animation, and UI logic. |

## Author

**Ritesh Udupa** — Systems & Software Architecture · Safety-Critical & Real-Time
Systems · ADAS/Autonomy.
[LinkedIn](https://www.linkedin.com/in/ritesh-udupa-4b694619/) ·
[GitHub](https://github.com/rudupa)

## License

Released under the [MIT License](LICENSE).
