# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to
[security@parallel.ai](mailto:security@parallel.ai). Include
`dsh-web-search security` in the subject line.

Please include the affected package and DSH versions, a minimal reproduction,
the expected impact, and any suggested mitigation. Remove API keys, tokens,
request headers, personal data, and raw customer or production data before
sending the report.

Do not open a public issue or publish exploit details before Parallel has had a
reasonable opportunity to investigate and coordinate a fix. We appreciate
responsible disclosure and will use the contact information in your report to
coordinate next steps.

## Supported versions

Until the first public release, security fixes are prepared on the repository's
main development line. After release, the latest published version is the
supported line unless a release notice states otherwise.

## Operational guidance

Keep `PARALLEL_API_KEY` in the environment that launches DSH rather than in a
profile file. Configuration dumps are readable text. For routine transport
verification, use `PARALLEL_LOG=info`; do not share debug logs without first
reviewing them for sensitive data.
