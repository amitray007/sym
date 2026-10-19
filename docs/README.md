# Sym documentation

These documents are the source of truth for Sym's design. Milestone 1 runs end to end on one
machine against fakes; [milestone-1.md](milestone-1.md) tracks what is built and what is left.
Read them in this order.

| Document | Covers |
|---|---|
| [vision.md](vision.md) | What Sym is, design rules, concepts, and the build order |
| [architecture.md](architecture.md) | Components, the job ledger, each flow traced, and failure modes |
| [workers.md](workers.md) | The worker adapter contract and the T3 Code adapter |
| [eve.md](eve.md) | Which Eve features Sym uses, defers, or skips, and their limits |
| [slack.md](slack.md) | Slack surfaces, the job card, scopes, and the app manifest |
| [display.md](display.md) | The display rule: when to post nothing, text, buttons, a card, or a file |
| [learning.md](learning.md) | The three learning layers and the feedback loop |
| [adopting.md](adopting.md) | Packs: where an adopter keeps playbooks, schedules, and repository rules |
| [self-hosting.md](self-hosting.md) | Network, credentials, and deployment, with Dokploy as the reference |
| [milestone-1.md](milestone-1.md) | Milestone 1: the spike, in build order, with exit criteria |
| [decisions/](decisions/README.md) | One record per accepted decision |
| [mockups/index.html](mockups/index.html) | Slack mockups and flow diagrams for every surface |

## Keep the docs current

- Record each new decision in `decisions/` and add it to `decisions/README.md`.
- Update the design document that the decision changes.
- Names in the mockups (Sam, J-142, billing sync) are examples. Keep them generic.
