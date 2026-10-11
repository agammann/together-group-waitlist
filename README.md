# Together

![Together — flexible dates, whole groups](docs/together-cover.png)

**Flexible dates. Whole groups.**

Together finds one ceramics session for a whole group across several acceptable dates, holds every seat, and turns a customer-approved PayPal sandbox payment into a confirmed booking.

The first version serves one studio, Stillwater, with six upcoming sessions in `America/Los_Angeles` and prices in USD. Customers can state their preferences in plain language or use the form. Local Qwen proposes the group size, acceptable sessions, and total budget; customers review the proposal before joining. The booking engine checks those constraints, preserves the group, and manages ten-minute offers. The studio screen shows availability and lets the operator release seats so the workflow can be demonstrated.

The [public source](https://github.com/agammann/together-group-waitlist) is available under the MIT license. Watch the [1:18 demonstration on YouTube](https://www.youtube.com/watch?v=5CnNIuXQrl8) to see the group waitlist, seat hold, customer approval, and confirmed sandbox booking. The Devpost project remains a draft; final contest submission and terms confirmation are pending.

## The workflow

A pair of friends can accept several dates and spend up to $75 together. One remaining place is insufficient. When another place opens in a suitable $32-per-person session, Together holds both places, shows the $64 total, and offers that single session to the pair. The customer approves the booking in PayPal sandbox; a verified capture confirms both places together.

The customer can inspect their request, cancel before payment is being resolved, and retry an expired offer. The studio can open places and see waiting groups, held offers, and completed bookings. A payment with an uncertain outcome keeps its places reserved until reconciliation resolves it.

## Run locally

Prerequisites: Node.js 24, pnpm, and [Ollama](https://ollama.com/). The model is `qwen3.5:4b-q4_K_M`.

```powershell
git clone https://github.com/agammann/together-group-waitlist.git
cd together-group-waitlist
pnpm install --frozen-lockfile
ollama pull qwen3.5:4b-q4_K_M
Copy-Item .env.example .env
```

Ollama normally runs as a service. If it is not running, start `ollama serve` in another terminal. Its default address is `http://127.0.0.1:11434`.

Fill in sandbox configuration in the local `.env` file. Then:

```powershell
pnpm build
pnpm start
```

Open **http://127.0.0.1:3210**. The server binds to loopback. Keep `.env` and local state out of source control. The initial six session dates are generated relative to the first run; the studio uses Los Angeles time throughout. Schedule, requests, offers, and receipts persist in `.data/state.json`; keep that file between restarts if you want to retain the demo.

`pnpm start` runs `node --env-file-if-exists=.env server.mjs`. For development, `pnpm dev` runs the server with Vite embedded. On this Windows workspace, `start.ps1` can use the bundled Node/pnpm runtime.

| Setting | Purpose |
| --- | --- |
| `PORT=3210` | Local web address port |
| `OLLAMA_BASE_URL=http://127.0.0.1:11434` | Local Ollama connection |
| `QWEN_MODEL=qwen3.5:4b-q4_K_M` | Model used to interpret preferences |
| `PAYPAL_CLIENT_ID` | Sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | Sandbox app secret, kept on the server |
| `DEMO_MODE=true` | Enables local studio controls and labeled checkout simulation |

`DEMO_MODE=false` disables studio mutation and simulated checkout endpoints. This setting is not a replacement for production authentication.

## PayPal sandbox setup

Create or select a sandbox app in the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox). Put its `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in your local `.env`. Use a separate sandbox personal account for buyer approval. The app calls the sandbox API; no live-money checkout is supported.

The server creates an order for the held seats using the studio price. The customer approves the booking in PayPal. The server then captures and verifies the payment before confirming the reservation. A return URL or browser message cannot confirm a booking.

Real checkout requires configured credentials and a working PayPal sandbox connection. The app also offers an explicitly marked simulated checkout for exploring the workflow. A simulated receipt is not evidence of a PayPal transaction. Without Qwen, the customer can enter preferences manually; that path does not claim a model interpretation.

## What to try

1. Enter a group request with two or more acceptable sessions and a total budget.
2. Review the proposed dates, group size, and budget before joining the waitlist.
3. On a fresh schedule, each session has one remaining place. A two-person group waits; open the studio screen and release one existing booking in an acceptable session to make two places available.
4. Inspect the offer: the whole group is held, its total price is shown, and the offer has a deadline.
5. Approve the specific booking and complete PayPal sandbox checkout, or choose the labeled simulation.
6. Return to the customer and studio screens to inspect the booking, receipt, and remaining capacity.

See [the demo script](docs/DEMO.md) for a short recording sequence, [research](docs/RESEARCH.md) for the documented problem and hackathon requirements, and [design direction](docs/DESIGN.md) for the current booking-site references and visual/UX decisions.

## Checks

```powershell
pnpm build
pnpm test
pnpm check:qwen
pnpm check:http
```

Build first: the production route and asset checks require `dist/`. `pnpm test` runs the automated checks. The Qwen check makes real calls to the configured local model and needs Ollama running. The HTTP check starts an isolated server with provider stubs and temporary state; it does not require or modify the main running app. Current results are recorded in [STATUS.md](STATUS.md) and [DELIVERY.json](DELIVERY.json). Test doubles and simulated checkout do not constitute real PayPal sandbox evidence.

The validated source checkpoint passed all **80 automated tests**, **3 actual local Qwen checks**, and a fresh archive install/build/test pass. Actual customer-approved sandbox bookings are recorded separately in [the payment evidence](docs/paypal-evidence.json). These results describe the local prototype and its tested constraints.

## Scope and payment rules

- A request accepts several sessions but books one session for the entire group.
- Dates outside the customer's selection and totals above the budget cannot be offered.
- Eligible requests are considered in arrival order. A group requiring more seats than are available remains waiting.
- Active holds count against availability. Expired offers release their seats.
- Session prices, quantities, and payment verification are owned by the server.
- There are no external booking-platform integrations, email/SMS delivery, or paid messaging services. Offers are visible in the app.

This is a local proof of concept. Its customer and studio screens share demo state on one computer; it is not a production service with customer authentication, tenancy, refunds, or operational monitoring. See `STATUS.md` and `DELIVERY.json` for the current validation evidence and remaining work.

## Technical outline

React and Vite provide the interface. A Node.js server owns the schedule, waitlist, offers, and receipts. Ollama runs Qwen locally to interpret customer preferences; deterministic checks enforce the booking constraints. The PayPal Orders v2 API handles sandbox order creation, buyer approval, capture, and verification.

MIT licensed. Copyright 2026 agammann.
