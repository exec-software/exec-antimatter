# Distribution and optional services

Antimatter's core workflow connects a desktop coding workspace to inference sources chosen
by the user. It can use local services or hosted providers; provider credentials and provider
charges remain the user's responsibility.

This document describes project boundaries, not a pricing plan or a promise of future services.

## Standalone operation

- Running the application must not depend on a maintainer's network, machine, account, or
  private project checkout.
- Local project files, conversation history, and credentials remain under the user's control.
- Optional integrations should explain their requirements and fail visibly when unavailable.
- Public release instructions must describe reproducible inputs and supported configurations.

## Distribution

The release process produces versioned application artifacts, integrity metadata, dependency
notices, and installation instructions. The current updater supports a trusted local or mounted
release feed. Hosted update delivery, commercial support, and any future services require their
own documented implementation and operating terms; they are not implied by this repository.

See the [release guide](../releases/README.md) for the implemented distribution workflow.
