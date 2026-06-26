# Third-party licenses

Sym itself is distributed under the [PolyForm Noncommercial License 1.0.0](LICENSE).
It depends on third-party open-source packages, all under permissive licenses
(MIT, Apache-2.0, BSD, ISC, and similar).

## Runtime dependency licenses

Every production (runtime) dependency — the packages that remain in the Docker
image after `pnpm prune --prod` — is under a permissive license:

| License        | Examples                                                              |
| -------------- | --------------------------------------------------------------------- |
| MIT            | Hono, ink, react, yaml, the Slack and MCP SDKs, and most else         |
| ISC            | a handful of small utilities                                          |
| Apache-2.0     | the AWS SDK / crypto packages pulled in transitively by the model SDK |
| 0BSD / BSD-2/3 | low-level utilities (e.g. tslib)                                      |

No copyleft licenses (GPL / AGPL / LGPL / MPL / EUPL) are present in the runtime
dependency tree. Regenerate this inventory at any time:

```sh
pnpm licenses list --prod
```

No Apache-2.0 `NOTICE` obligations are triggered by these packages as used, so a
NOTICE file is not legally required; attribution is preserved here as good
practice for redistribution (e.g. the published Docker image).

## Dependency audit (dev-only findings)

`pnpm audit` reports findings only in the **development** test toolchain
(`vitest` / `vite` / `esbuild`), which is **not shipped** to production. The
runtime image is built with `pnpm prune --prod`, so `pnpm audit --prod` — the
packages that actually ship — reports **no known vulnerabilities**, and that is
the audit gated in CI.

- The `vitest < 4.1.0` "critical" advisory concerns the **Vitest UI server**
  (`vitest --ui`). Sym only ever runs `vitest run`, never the UI, so it is not
  exploitable here. The remediation (`vitest` 2 → 4, a breaking major upgrade) is
  tracked separately.

## SBOM

A full CycloneDX/SPDX software bill of materials is deferred to the first tagged
release.
