# Checkout

A checkout web app and two .NET services. There is no root package; each part installs and tests from its own folder.

- `apps/checkout-web/`: the checkout app, in TypeScript with pnpm.
- `services/commerce-core/`: orders, a .NET solution with its tests.
- `services/identity-dev/`: a local sign-in stub for development, in .NET.
- `bench/checkout-load/`: a load script for checkout, not shipped.
