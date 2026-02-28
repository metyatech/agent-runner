# Contributing

Thank you for your interest in contributing to `agent-runner`.

## Development setup

```bash
git clone https://github.com/metyatech/agent-runner.git
cd agent-runner
npm install
npm run verify   # lint + format:check + test + build
```

## Submitting changes

1. Fork the repository and create a feature branch.
2. Add or update tests for any changed behavior.
3. Run `npm run verify` and ensure all checks pass.
4. Open a pull request with a clear description of the change.

## Code style

- TypeScript strict mode is required.
- Format with Prettier (`npm run format`).
- Lint with ESLint (`npm run lint`).

## Code of conduct

This project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating,
you are expected to uphold it in all project spaces.
