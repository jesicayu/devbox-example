import { sign } from "node:crypto";
import { createServer } from "node:http";
import type { Devbox } from "@namespacelabs/sdk";
import type { TokenSource } from "@namespacelabs/sdk/auth";

export const prompt = (customerId: string, tenantId: string, devboxId: string) => `Create index.html in this directory: a single self-contained web page with inline CSS, no JavaScript, and nothing loaded from the internet. Do not start a server or create any other file.

Content, in this order:
- A small label "Namespace".
- The heading "Hello from ${customerId}".
- Two labelled values, each in its own monospace box: "Tenant ID" ${tenantId} and "Devbox ID" ${devboxId}.
- Exactly this form, unchanged: <form method="post" action="destroy"><button type="submit">Destroy devbox and tenant</button></form>

Style it like namespace.so: page background #F6F7FC, text #171C2B, muted labels #60689F, font Inter with system sans-serif fallbacks. Center a white card about 480px wide with a 1px #EAECF2 border, 12px corners and 40px padding. Put the values in #F1F2F6 boxes with 6px corners. Make the button full width, pill shaped, background #1C32FF with white text.

When done, commit index.html.`;

export function partnerTokenSource(key: Buffer, issuer: string, partnerId: string, keyId: string): TokenSource {
	return {
		async issueToken() {
			const now = Math.floor(Date.now() / 1000);
			const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
			const header = encode({ alg: "ES256", typ: "JWT", kid: keyId });
			const claims = encode({ iss: issuer, sub: partnerId, aud: "namespace.so", iat: now, exp: now + 20 * 60 });
			const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
			return `oidc_${header}.${claims}.${signature.toString("base64url")}`;
		},
	};
}

export async function runAgent(devbox: Devbox, task: string, platform: string, log: (message: string) => void) {
	const projectDir = `${devbox.info.workspaceDir}/project`;
	const install = await retry(log, () => devbox.shell(
		`curl -fsSL https://ampcode.com/install.sh | bash && sudo ln -sf ~/.amp/bin/amp /usr/local/bin/amp && mkdir -p ${projectDir} && git -C ${projectDir} init -q && git -C ${projectDir} -c user.name=${platform} -c user.email=${platform}@example.com commit -q --allow-empty -m "Empty project"`,
	));
	if (install.exitCode !== 0) throw new Error(`installing Amp failed: ${install.stderr || install.stdout}`);
	log(`installed Amp and created ${projectDir}`);

	const service = await retry(log, () => devbox.services
		.create({ name: "amp-runner", command: "amp", args: ["--no-tui", "--runner-id", devbox.name], cwd: projectDir })
		.catch(() => devbox.services.get("amp-runner")));
	log(`started service ${service.name}: ${service.process?.state}`);

	const deadline = Date.now() + 3 * 60_000;
	let events: { type: string; session_id?: string; result?: string; is_error?: boolean }[] = [];
	while (!events.some((event) => event.type === "result")) {
		const result = await devbox
			.exec(["amp", "-x", task, "--executor", `runner:${devbox.name}`, "--stream-json"], { cwd: projectDir })
			.catch(() => undefined);
		if (result?.exitCode === 0) {
			events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		} else if (result && !result.stderr.includes("No connected runner")) {
			throw new Error(`amp -x failed: ${result.stderr}`);
		} else if (Date.now() > deadline) {
			throw new Error("the Amp runner did not connect within 3 minutes");
		} else {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
	}
	const outcome = events.find((event) => event.type === "result")!;
	log(`agent finished (${outcome.is_error ? "error" : "success"}): https://ampcode.com/threads/${outcome.session_id}`);

	const built = await retry(log, () => devbox.exec(["test", "-f", "index.html"], { cwd: projectDir }));
	if (built.exitCode !== 0) throw new Error("the agent did not create index.html; see its thread above");
	return projectDir;
}

export const retry = async <T>(log: (message: string) => void, step: () => Promise<T>): Promise<T> => {
	for (let attempt = 1; ; attempt++) {
		try {
			return await step();
		} catch (error) {
			if (attempt === 5 || !/Premature close|connection is closed|ECONNRESET|socket hang up/i.test(String(error))) throw error;
			log(`connection to the devbox dropped (${error instanceof Error ? error.message : error}), retrying`);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
};

export const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #F6F7FC; color: #171C2B; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
	main { width: min(92vw, 480px); background: #fff; border: 1px solid #EAECF2; border-radius: 12px; padding: 40px; box-shadow: 0 1px 2px rgba(23, 28, 43, 0.04); }
	.brand { color: #60689F; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 24px; }
	h1 { font-size: 32px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 28px; }
	dl { margin: 0 0 32px; display: grid; gap: 16px; }
	dt { color: #8B91B9; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
	dd { margin: 0; font-family: "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; background: #F1F2F6; border-radius: 6px; padding: 10px 12px; }
	button { width: 100%; border: 0; border-radius: 9999px; padding: 14px 20px; background: #1C32FF; color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
	button:hover { background: #1426d6; }
	p { color: #60689F; margin: 0; }
</style>
</head>
<body><main><p class="brand">Namespace</p>${body}</main></body>
</html>`;

export async function startProxy(port: number) {
	const sites = new Map<string, { url: string; tenantTokens: TokenSource; destroy: () => Promise<void> }>();
	const proxy = createServer(async (request, response) => {
		const [, customerId, action] = (request.url ?? "/").split("/");
		const site = sites.get(customerId);
		if (!site) return response.writeHead(404).end(page("Not found", `<h1>Not found</h1><p>No running devbox for "${customerId}".</p>`));
		if (action === undefined) return response.writeHead(302, { location: `/${customerId}/` }).end();
		try {
			if (request.method === "POST" && action === "destroy") {
				await site.destroy();
				return response.writeHead(200, { "content-type": "text/html" }).end(page("Destroyed", `<h1>Destroyed</h1><p>The devbox and tenant for ${customerId} are gone.</p>`));
			}
			const upstream = await fetch(site.url, { headers: { "x-nsc-ingress-auth": `Bearer ${await site.tenantTokens.issueToken(60_000)}` } });
			response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/html" }).end(await upstream.text());
		} catch (error) {
			response.writeHead(502).end(String(error));
		}
	});
	await new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve));
	console.log(`local proxy listening on http://localhost:${port}`);
	return { sites, proxy };
}
