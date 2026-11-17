import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createDevboxClient } from "@namespacelabs/sdk";
import { createIAMClient } from "@namespacelabs/sdk/api/iam";
import { createVaultClient } from "@namespacelabs/sdk/api/vault";
import { cachingTokenSource } from "@namespacelabs/sdk/auth";
import { partnerTokenSource, prompt, retry, runAgent, startProxy } from "./helpers.js";

const platform = "my-platform-devbox";
const customers = ["customer-1", "customer-2"];
const proxyPort = 4100;
const webPort = 3000;

const env = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name} in .env`);
	return value;
};

const ampToken = env("AMP_API_KEY");
const partnerKey = await readFile(env("NAMESPACE_PARTNER_KEY_FILE").replace(/^~(?=\/)/, homedir()));

async function main() {
	const partnerTokens = partnerTokenSource(partnerKey, env("NAMESPACE_PARTNER_ISSUER"), env("NAMESPACE_PARTNER_ID"), env("NAMESPACE_PARTNER_KEY_ID"));
	const partner = createIAMClient({ tokenSource: partnerTokens });
	console.log("signed partner token");

	const tenantIds = new Set<string>();
	const removeTenants = async () => {
		for (const tenantId of tenantIds) {
			await partner.tenants.removeTenant({ tenantId });
			tenantIds.delete(tenantId);
		}
	};

	process.once("SIGINT", () => {
		console.log("interrupted, cleaning up");
		removeTenants().finally(() => process.exit(130));
	});

	const { sites, proxy } = await startProxy(proxyPort);

	async function runCustomer(customerId: string) {
		const log = (message: string) => console.log(`[${customerId}] ${message}`);
		const { tenant } = await partner.tenants.ensureTenantForExternalAccount({
			externalAccountId: `${platform}:${customerId}`,
			visibleName: customerId,
		});
		const tenantId = tenant!.id;
		tenantIds.add(tenantId);
		log(`created tenant ${tenantId}`);

		const tenantTokens = cachingTokenSource({
			async issueToken() {
				const { bearerToken } = await partner.tenants.issueTenantToken({ tenantId, actorId: platform, durationSecs: 30n * 60n });
				return bearerToken;
			},
		});
		log("issued tenant token");

		const { vault } = createVaultClient({ tokenSource: tenantTokens });
		const { objectId: secretId } = await vault.createObject({ description: "Amp access token", value: ampToken, revealable: false });
		log(`stored Amp token in Vault secret ${secretId}`);

		const client = createDevboxClient({ tokenSource: tenantTokens });
		let url: string;
		try {
			const blueprint = await client.blueprints.create(`${platform}-agent`, {
				image: "builtin:default",
				size: "m",
				environment: { AMP_API_KEY: { secretId } },
				networkPolicy: { allowedDomains: ["ampcode.com", "*.ampcode.com", "registry.npmjs.org"] },
			});
			log(`created blueprint ${blueprint.name}`);

			const devbox = await client.devboxes.create({ name: `${platform}-${customerId}`, blueprint: blueprint.name });
			log(`created devbox ${devbox.name} (${devbox.id}): ${devbox.info.state}`);
			const projectDir = await runAgent(devbox, prompt(customerId, tenantId, devbox.id), platform, log);

			await retry(log, () => devbox.services
				.create({
					name: "web",
					command: "node",
					args: ["-e", `require("http").createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(require("fs").readFileSync("index.html")); }).listen(${webPort})`],
					cwd: projectDir,
					restartPolicy: "always",
				})
				.catch(() => devbox.services.get("web")));
			const port = await retry(log, () => devbox.exposedPorts
				.create({ name: "web", number: webPort })
				.catch(() => devbox.exposedPorts.get({ number: webPort })));
			url = port.url;
			log(`started service web serving the agent's index.html at ${url}`);
		} finally {
			client.close();
		}

		await new Promise<void>((resolve) => {
			sites.set(customerId, {
				url,
				tenantTokens,
				destroy: async () => {
					sites.delete(customerId);
					await partner.tenants.removeTenant({ tenantId });
					tenantIds.delete(tenantId);
					log(`destroy clicked: removed tenant ${tenantId} and its devbox`);
					resolve();
				},
			});
			log(`open http://localhost:${proxyPort}/${customerId}/`);
		});
	}

	try {
		const run = Promise.all(customers.map(runCustomer));
		await Promise.race([
			run.then(() => console.log("both devboxes and tenants destroyed")),
			new Promise((resolve) => setTimeout(resolve, 30 * 60_000).unref()).then(() => console.log("no clicks for 30 minutes")),
		]);
	} finally {
		proxy.close();
		proxy.closeAllConnections();
		await removeTenants();
		console.log("cleaned up");
	}
}

main().catch((error) => {
	console.error("failed:", error instanceof Error ? error.message : error);
	process.exit(1);
});
