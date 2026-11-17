# my-platform-devbox

Gives two customers their own [Namespace](https://namespace.so) tenant and runs, on a Devbox inside each, an [Amp](https://ampcode.com) agent that builds a small web page, served by a Namespace service. Built with the [Namespace TypeScript SDK](https://github.com/namespacelabs/typescript-sdk).

```bash
npm install
cp .env.example .env   # Amp token and partner credentials
npm start
```

[`src/multitenant-agent.ts`](src/multitenant-agent.ts) contains the customer flow and cleanup. [`src/helpers.ts`](src/helpers.ts) handles JWT signing, Amp installation and execution, the prompt, and the local proxy. The example runs these steps and logs each one:

1. Signs a partner token with your partner key.
2. Starts a local proxy on http://localhost:4100.
3. For `customer-1` and `customer-2`, in parallel:
   1. Creates the customer's tenant and issues a tenant token for it.
   2. Stores the Amp token in the tenant's Vault.
   3. Creates a blueprint in the tenant: built-in image, the Amp token from the Vault, and a network policy that allows Amp and npm.
   4. Creates a Devbox from the blueprint.
   5. Installs the Amp CLI on it with `devbox.exec` and creates an empty git project.
   6. Starts `amp --no-tui` as the `amp-runner` service and asks the agent to build `index.html`: a Namespace-styled page showing "Hello from <customer>", the tenant and Devbox IDs, and a "Destroy devbox and tenant" button. Prints the agent's thread link when it finishes.
   7. Serves the agent's page as the `web` service and exposes it on a devbox.so URL.
   8. Prints `http://localhost:4100/<customer>/`.
4. Waits until "Destroy devbox and tenant" has been clicked on both pages. Each click removes that customer's tenant and its Devbox.
5. Removes any remaining tenants used by this run and exits. It also cleans up on Ctrl+C or after 30 minutes without clicks. It does not scan for or clean up tenants from previous runs.

The devbox.so URLs need credentials for the customer's tenant: your own Namespace login belongs to your workspace, not to the tenants your platform creates. The local proxy fetches each page with a tenant token in the `x-nsc-ingress-auth` header, so you can open them in your browser.

Tenants, Vault secrets, blueprints, and Devboxes all belong to one tenant, so each customer gets their own copy and can't see the other's.

Partner credentials are issued by the Namespace team today ([support@namespace.so](mailto:support@namespace.so)); this may change once partner access is self-service. Both customers' agents use your Amp token here; a real platform would store each customer's own.
