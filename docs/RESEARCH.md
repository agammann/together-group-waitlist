# Research and build rationale

Together addresses a documented date-by-date waitlist limitation with one request for a complete group across several acceptable sessions.

## Documented problem

[Bookwhen's Waiting Lists article](https://support.bookwhen.com/en/articles/753351-waiting-lists) explains that a course waitlist applies only to the selected date. Customers do not receive notifications for other course dates and must join separately for each date. Together lets a customer state several acceptable dates once, then reserves one session for the entire group when enough capacity becomes available.

The source supports this specific limitation. It does not establish that Bookwhen lacks all group-booking features or that studios will adopt a separate schedule manager. Adoption and integration demand remain untested.

## Hackathon fit

Checked against the [PayPal AI Hackathon overview](https://paypalaihackathon.devpost.com/) and [official rules](https://paypalaihackathon.devpost.com/rules) on October 10, 2026:

- Free PayPal sandbox integration is required; entrants may choose any AI tool, model, or platform. Local Qwen therefore fits the permitted architecture by inference, provided its role is meaningful.
- A local functional build with complete setup/run instructions is allowed; public hosting is optional.
- Submission closes November 12, 2026 at noon Pacific. Judging runs December 1–15.
- Required materials include the feature description, public open-source repository and visible license, runnable source/assets/instructions, and a public YouTube demonstration under three minutes.
- Implementation, design, impact, innovation, and presentation are equally weighted. Entries must be substantially distinct from an entrant's other submissions.

These requirements inform the build; they do not establish that it has been submitted or that its materials are complete. No terms acceptance or contest submission is recorded in this project.

## Product decisions

The first version manages Stillwater's own six-session schedule in Los Angeles time. It demonstrates customer and studio screens without integrating another booking platform. Local Qwen turns a natural-language request into a proposal. Customer review separates interpretation from authorization. Deterministic matching enforces group size, selected dates, budget, arrival order, and availability. A specific time-limited offer precedes payment approval.

The [PayPal Orders v2 API](https://developer.paypal.com/api/orders/v2) provides create, retrieve, and capture operations. A booking becomes paid only after the server verifies the sandbox capture. The [Ollama chat API](https://docs.ollama.com/api/chat) supplies local model invocation. Model failures use the manual preference form; simulated checkout is labeled separately from sandbox evidence.

## Evidence to maintain

Keep these evidence classes distinct: deterministic engine/provider tests, rendered browser behavior, real local Qwen responses, and actual PayPal sandbox captures. Test results support implementation correctness within their tested conditions. They do not establish adoption, production readiness, or an actual provider transaction unless that transaction was observed.
