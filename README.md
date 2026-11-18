# Together

![Together — flexible dates, whole groups](docs/together-cover.png)

**Flexible dates. Whole groups.**

Together finds one ceramics session for a whole group across several acceptable dates, holds every seat, and turns a customer-approved PayPal sandbox payment into a confirmed booking.

The local app serves one studio, Stillwater, with six upcoming sessions in `America/Los_Angeles` and prices in USD. Customers can state their preferences in plain language or use the form. Local Qwen proposes the group size, acceptable sessions, and total budget. Customers review the proposal before joining. The booking engine checks those constraints, preserves the group, and manages ten-minute offers. The studio screen shows availability and lets the operator release seats in the local demonstration.

The [public source](https://github.com/agammann/together-group-waitlist) is available under the MIT license. Watch the [1:18 demonstration on YouTube](https://www.youtube.com/watch?v=5CnNIuXQrl8) to see the group waitlist, seat hold, customer approval, and confirmed sandbox booking. Together was [submitted to the PayPal AI Hackathon on Devpost](https://devpost.com/software/together-u0efg3) on October 11, 2026.

## The workflow

A pair of friends can accept several dates and spend up to $75 together. One remaining place is insufficient. When another place opens in a suitable $32-per-person session, Together holds both places, shows the $64 total, and offers that single session to the pair. The customer approves the booking in PayPal sandbox; a verified capture confirms both places together.

The customer can inspect their request, cancel before payment is being resolved, and retry an expired offer. The studio can open places and see waiting groups, held offers, and completed bookings. A payment with an uncertain outcome keeps its places reserved until reconciliation resolves it.

## Run locally

Use Node.js 24 and pnpm 11.25.0, the versions used for the project checks. A fresh checkout supports the manual form, studio demo and labeled checkout simulation without Ollama, PayPal credentials or an `.env` file.

```powershell
git clone https://github.com/agammann/together-group-waitlist.git
cd together-group-waitlist
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://127.0.0.1:3210**. The server binds to loopback. Enter your dates, group size and budget manually, then follow **What to try** below. The first run creates six upcoming dates in Los Angeles time. Schedule, requests, offers and receipts persist in `.data/state.json`. Keep that file to preserve the demo when restarting.

`pnpm start` runs `node --env-file-if-exists=.env server.mjs`. For development, `pnpm dev` runs the server with Vite embedded. On Windows, `start.ps1` uses installed Node and pnpm, or a local Codex pnpm fallback when present.

### Optional local preference interpretation

Install [Ollama](https://ollama.com/) and run its local server at `http://127.0.0.1:11434`. Together accepts this exact address. Pull the model if it is absent from your local installation:

```powershell
ollama pull qwen3.5:4b-q4_K_M
```

Use **Use my preferences** in the app. Review the dates, group size and total budget before joining. The manual form remains available if local interpretation is unavailable.

To change settings, copy `.env.example` to `.env`. Keep `.env` and local state out of source control.

| Setting | Purpose |
| --- | --- |
| `PORT=3210` | Local web address port |
| `DATA_FILE` | Optional path to an independent state file. Defaults to `.data/state.json` |
| `OLLAMA_BASE_URL=http://127.0.0.1:11434` | The supported local Ollama address |
| `QWEN_MODEL=qwen3.5:4b-q4_K_M` | Model used to interpret preferences |
| `PAYPAL_CLIENT_ID` | Sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | Sandbox app secret, kept on the server |
| `DEMO_MODE=true` | Enables local studio controls and labeled checkout simulation |

`DEMO_MODE=false` hides the Studio view and disables the simulated checkout. The local app does not have production authentication.

## PayPal sandbox setup

For an actual sandbox checkout, create or select a sandbox app in the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox). Put its `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in your local `.env`. Use a separate sandbox personal account for buyer approval. The app calls the sandbox API and uses simulated funds.

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

The preserved delivery checkpoint passed all **80 automated tests**, **3 actual local Qwen checks**, and a fresh archive install/build/test pass. Actual customer-approved sandbox bookings are recorded separately in [the payment evidence](docs/paypal-evidence.json). These results describe that checkpoint and its tested constraints. Run `pnpm test` after `pnpm build` for the current checkout's count and result; later tests are not retroactively part of the preserved delivery evidence.

## Scope and payment rules

- A request accepts several sessions but books one session for the entire group.
- Dates outside the customer's selection and totals above the budget cannot be offered.
- Eligible requests are considered in arrival order. A group requiring more seats than are available remains waiting.
- Active holds count against availability. Expired offers release their seats.
- Session prices, quantities, and payment verification are owned by the server.
- There are no external booking-platform integrations, email/SMS delivery, or paid messaging services. Offers are visible in the app.

The customer and studio screens share demo state on one computer. Production authentication, tenancy, refunds and operational monitoring are outside the app’s scope. `STATUS.md` and `DELIVERY.json` record the original delivery and its verification limits.

## Technical outline

React and Vite provide the interface. A Node.js server owns the schedule, waitlist, offers, and receipts. Ollama runs Qwen locally to interpret customer preferences; deterministic checks enforce the booking constraints. The PayPal Orders v2 API handles sandbox order creation, buyer approval, capture, and verification.

MIT licensed. Copyright 2026 agammann.
