# gPTP / STBM Time Synchronization Visualizer

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
- A detailed explainer page ([docs.html](docs.html)) covering every term and mode
  with worked numeric examples.

## Run locally

Just open `index.html` in a browser — there is nothing to install or build.

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
