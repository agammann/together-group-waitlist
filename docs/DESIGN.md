# Together design direction

Together should feel like an inviting ceramics studio with a clear booking task: choose several dates, keep your group together, and approve one specific offer when seats open.

The visual direction uses warm ivory, deep evergreen, and clay accents, with an editorial serif headline and a large pottery photograph. The photograph communicates the activity immediately; the booking controls remain plain and readable. This direction is an original proposal for Together, informed by the current public booking pages below.

## What was inspected

On October 10, 2026, the public desktop pages of ClassPass, Tock, and Airbnb Experiences were opened, read, and visually inspected in the browser. ClassPass's schedule was inspected both on an empty day and after moving to the next day. Airbnb's discovery screen and a creative-workshop detail page were inspected. This was a focused design reference pass, not a usability study or a completed checkout audit. No source images, logos, ratings, testimonials, or other assets were copied.

## Transferable patterns

| Pattern | Observed source | Implication for Together |
| --- | --- | --- |
| Put the booking constraints together | [Tock homepage](https://www.exploretock.com/) presents clearly labeled reservation type, location, date, time, and party size in one horizontal strip, ending in a saturated search control. | Group size and total budget belong together in one concise panel. Keep the customer’s acceptable date choices nearby; avoid scattering inputs across several unrelated cards. |
| Let the activity carry the visual identity | [Airbnb Experiences](https://www.airbnb.com/experiences) uses large experience photographs, compact titles, visible times, and brief price metadata on a light background. | Use one prominent original pottery photograph and a strong headline. Six sessions need clear rows, not six repetitive stock-photo cards. Photographic color can make an ivory interface feel lively. |
| Separate storytelling from booking | The [silk-scarf workshop detail](https://www.airbnb.com/experiences/870991) shows a large photo collection beside a narrower title/highlights/price/date column. | Give the studio story and schedule the wider area on desktop, with one focused request or offer panel beside them. On mobile, stack the story, date choices, then request controls in reading order. |
| Make sessions easy to scan and empty states actionable | The [YogaSix ClassPass schedule](https://classpass.com/studios/yogasix-yorba-linda) uses thin-divider rows with time/duration, class/instructor, and a booking-related action. An unavailable day has a next-day action. | Show weekday/day, start time, class name, price, and capacity in a consistent order. An empty or waiting state should explain what happens next, with a clear action when appropriate. |
| State the pricing unit | [Airbnb Experiences](https://www.airbnb.com/experiences) distinguishes per-guest pricing from per-group pricing in its cards. | Label session prices as per person and show the group total in the request review and offer. Do not make the customer multiply prices to decide whether an offer fits their budget. |

These observations establish that the patterns are present. Their effect on Together's usability is a design hypothesis to test with real users; the source pass does not prove conversion or adoption.

## Apply now

The customer screen should have a short navigation bar with a clear customer/studio switch, a generous studio introduction with the pottery photograph, and a booking area with six selectable session rows. Each row should have a full-row hit area, an explicit selected state, and a human-readable availability label. Keep one strong primary action at each step: interpret preferences, review/join, then approve the offered booking.

Use deep evergreen for primary actions and selected states. Use clay for the studio identity and restrained accents rather than large low-contrast text areas. The editorial heading can be large and expressive; dates, budgets, prices, and controls should use a simple sans serif. Light borders and intentional spacing are sufficient to organize the screen. Reserve enclosed panels for the request, active offer, and receipt, where boundaries help the task.

The offer should show the session, complete group count, per-person price, group total, deadline, and the exact approval action. Keep the PayPal sandbox action visually distinct from the labeled simulation. On the receipt, the result and group/session details come before transaction metadata.

Customer copy should describe the task and result. Provider configuration and troubleshooting belong in the documentation or studio connection status. The customer should understand why a request is waiting without reading model or API terminology.

## Accessibility constraints

- Keep body text at least 4.5:1 against its background and large text at least 3:1. A warm palette still needs dark, readable text. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- WCAG 2.2's minimum target criterion is 24 by 24 CSS pixels, subject to its exceptions. Together's date rows and main controls should aim for generous 44-pixel-or-larger heights as a product choice, with clear space between targets. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- Preserve a visible keyboard focus indicator, meaningful labels, and selected states that are conveyed in text or control semantics as well as color. [W3C focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- A ten-minute offer needs a visible deadline and understandable expiry state. Avoid announcing a changing countdown every second to screen readers. Time limits require an explicit accessibility review; displaying a countdown alone does not establish conformance. [W3C timing guidance](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html)

## Verification before handoff

Inspect the rendered screen at desktop and mobile widths, then use the actual date selection, preference review, waiting state, offer, and receipt. Check that the main next action is obvious at every step, the photograph has a purposeful crop, text remains readable, and the mobile layout has no horizontal overflow. Tab through the interactive controls, verify the selected dates, and inspect provider errors and expiry copy. Record the observed results in the delivery evidence; this design note alone is not an accessibility or usability certification.

## Final concept comparison

The local design references are `../design/customer-concept.png` and `../design/studio-concept.png`, relative to the project directory. Both concepts were inspected alongside the final browser captures. Validation used the Codex in-app browser at 1487 × 1058 and 390 × 844. Full-page captures extend below the viewport. The concepts guide the composition; they are not claims of pixel-identical reproduction.

| Comparison point | Final result |
| --- | --- |
| Composition | Preserves the short navigation, wide story/schedule area, narrower booking rail, and three-step footer. The phone layout stacks these in reading order. |
| Palette and surfaces | Preserves warm ivory, dark evergreen, clay accents, sage selected rows, light borders, and restrained panel shadows. |
| Typography | Keeps expressive serif headings. Bundled DM Sans provides clearer dates, controls, and transaction details; this is an intentional departure from the concept's more extensive serif text. |
| Photography | Uses an original pottery photograph with a deliberate wide crop. It differs from the concept photograph while retaining the activity, warm light, hands, and clay. |
| Schedule and booking controls | Preserves open date rows and the single booking panel. Actual 90-minute sessions, stock counts, budget validation, customer review, expiry, consent, and payment results replace static concept data. |

The customer headline and subheading remain “Good things happen together.” and “One waitlist. A few dates. Room for everyone.” The studio headline remains “Make room for everyone.” Copy changes are purposeful state transitions: the completed booking panel reads “See you at the wheel.” and confirms the exact session, group total, and verified sandbox payment. Header spacing, the bundled UI font, and longer functional receipt/activity content produce a taller full-page render than the concept.

The browser flow exercised real Qwen review and application, a two-person request across five acceptable dates, studio release of one existing place, a full-group hold, expiry and retry, explicit booking consent, PayPal sandbox approval, automatic return, and a provider-verified receipt. A separate labeled simulation was also exercised. After a production restart, the receipt persisted and studio capacity remained correct. The final desktop page had no console warnings or errors; the 390-pixel mobile receipt had no horizontal overflow. Phone captions were enlarged after inspection. Keyboard/screen-reader conformance, other browser engines, and real-user adoption remain untested.
