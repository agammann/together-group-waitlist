# Together status

Together is running locally with tested group matching, real local Qwen preference interpretation, and a completed PayPal sandbox booking for two people.

This checkpoint was recorded on October 10, 2026 in `America/Los_Angeles`. The app is available at **http://127.0.0.1:3210/**.

## Implemented

The customer and studio screens manage Stillwater's own six upcoming ceramics sessions. Customers select acceptable dates, group size, and a total USD budget, or review a proposal interpreted by local Qwen. Deterministic matching keeps the whole group together, checks constraints in arrival order, accounts for held capacity, and creates ten-minute offers. Customer approval precedes PayPal order creation; server-verified capture precedes booking confirmation. Labeled simulated checkout remains a separate demonstration path.

## Validation evidence

| Check | Result | Evidence boundary |
| --- | --- | --- |
| Production build | Passed | React/Vite production assets built successfully. |
| Automated tests | 80/80 passed | 13 booking tests, 51 provider tests, and 16 HTTP tests. Provider responses in these tests are controlled stubs. |
| HTTP smoke check | Passed | Isolated local server with provider stubs; separate from the real sandbox transaction below. |
| Real local Qwen check | 3/3 passed | Actual `qwen3.5:4b-q4_K_M` calls through Ollama; no substitute interpretation. Completed at `2026-10-11T06:04:59Z`, October 10 at 11:04:59 p.m. Pacific. |
| Desktop and mobile rendering | Verified | Desktop at 1487 × 1058 and an actual 390-pixel-wide viewport. |
| Production root route and assets | Passed regression checks | A root-route 404 was corrected and the production route/asset regression checks passed. |
| Real PayPal sandbox checkout | Completed and server verified | Buyer approved a specific two-person booking; the app returned automatically and verified the capture before confirming it. |
| Fresh source archive | Passed | Extracted separately; frozen-lockfile install, production build, all 80 tests, and HTTP smoke check passed with Node 24.19.0 and pnpm 11.25.0. No private environment file or original node_modules was copied. |

The Qwen checks included a complete two-person weekend-afternoon request, a request missing group size and budget, and a per-person budget converted to a group total. Interpretation is a constrained proposal; server validation and customer review still apply.

## Observed sandbox booking

- Session: Wheel basics, Saturday October 17, 2026 at 2:00 p.m. Los Angeles time.
- Group: two people.
- Total: **$64.00 USD**, sandbox only.
- PayPal order: `94624019B5642974G`.
- Completed capture: `45L280797N074744P`.

This is actual provider evidence. It is distinct from simulated checkout and the provider stubs used in automated checks. An independent PayPal GET at `2026-10-11T06:28:28Z` confirmed the order and capture as `COMPLETED`, including the exact USD total and booking references. Sanitized evidence is saved in `docs/paypal-evidence.json`.

## Delivery and remaining submission work

The production process was stopped and restarted through `start.ps1`. A fresh browser tab retained the confirmed two-person receipt and the same capture ID. The studio showed one booked group, no active holds, and the booked session at 8 of 8 places. The fresh production page reported no console warnings or errors. The final mobile receipt had a 390-pixel viewport and no horizontal overflow.

The source archive `../together-source.zip` contains the runnable source, original studio photograph, tests, MIT license, and setup documentation. It excludes `.env`, runtime data, `node_modules`, and `dist`. The README provides installation, model setup, build, and run instructions. `start.ps1` was exercised successfully on this workspace.

No public repository, public demo video, or Devpost submission has been created or authorized for this project. Contest materials still require publication and a visible recording before submission. The current [official deadline](https://paypalaihackathon.devpost.com/rules) is November 12, 2026 at noon Pacific.

## Product limits

The application serves one studio on one local computer. It has no external booking-platform integration, paid messaging, email/SMS delivery, production account/role system, tenancy, refunds, or operational monitoring. Customer adoption has not been tested. Browser checks and automated tests support the demonstrated prototype; they do not establish production readiness.

See [README.md](README.md), [the demo script](docs/DEMO.md), [research](docs/RESEARCH.md), and [design rationale](docs/DESIGN.md) for setup and next steps.
