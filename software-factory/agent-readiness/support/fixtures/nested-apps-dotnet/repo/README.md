# Storefront

Two web apps and one .NET service, each with its own toolchain. There is no root package.

- `apps/buyer-web/`: the shopper-facing app.
- `apps/admin-web/`: the back-office app.
- `services/commerce-core/`: orders and payments, in .NET.

Each app installs and tests on its own with npm, from its own folder.
