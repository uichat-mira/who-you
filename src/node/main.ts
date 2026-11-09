import { handleScheduled } from "../app";
import { resolveNodeConfig } from "./config";
import {
	closeHttpServer,
	createHttpServer,
	listenHttpServer,
} from "./http-server";
import { runMigrations } from "./migrations";
import {
	closeInboundSmtp,
	createInboundSmtpServer,
	listenInboundSmtp,
} from "./smtp-inbound";

const log = (event: string, detail: Record<string, unknown> = {}): void => {
	console.log(JSON.stringify({ event, ...detail }));
};

async function main(): Promise<void> {
	const resolved = resolveNodeConfig();
	if (!resolved.ok) {
		log("whoyou_node_config_error", { reason: resolved.reason });
		process.exitCode = 1;
		return;
	}
	const { config } = resolved;

	const applied = runMigrations(config.db.raw, config.migrationsDir);
	log("whoyou_node_start", {
		appliedMigrations: applied,
		httpHost: config.http.host,
		httpPort: config.http.port,
		sweepIntervalMs: config.sweepIntervalMs,
		inboundSmtp: config.inboundSmtp === null ? null : `${config.inboundSmtp.host}:${config.inboundSmtp.port}`,
		outboundRelayConfigured: config.outboundRelayConfigured,
	});

	const httpServer = createHttpServer({
		host: config.http.host,
		port: config.http.port,
		env: config.env,
		db: config.db,
	});
	const actualPort = await listenHttpServer(httpServer, config.http.host, config.http.port);
	log("whoyou_http_listening", { host: config.http.host, port: actualPort });

	const inboundServer =
		config.inboundSmtp === null
			? null
			: createInboundSmtpServer(config.inboundSmtp, config.env);
	if (config.inboundSmtp !== null && inboundServer !== null) {
		await listenInboundSmtp(inboundServer, config.inboundSmtp.host, config.inboundSmtp.port);
		log("whoyou_inbound_smtp_listening", {
			host: config.inboundSmtp.host,
			port: config.inboundSmtp.port,
		});
	}

	let sweeping = false;
	const timer = setInterval(() => {
		if (sweeping) {
			log("whoyou_sweep_skipped", { reason: "previous_sweep_still_running" });
			return;
		}
		sweeping = true;
		void handleScheduled(config.env)
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : "unknown error";
				log("whoyou_sweep_error", { error: message });
			})
			.finally(() => {
				sweeping = false;
			});
	}, config.sweepIntervalMs);
	timer.unref();

	let shuttingDown = false;
	const shutdown = (signal: string): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		log("whoyou_node_shutdown", { signal });
		clearInterval(timer);
		void (async () => {
			try {
				if (inboundServer !== null) await closeInboundSmtp(inboundServer);
				await closeHttpServer(httpServer);
			} catch (error) {
				const message = error instanceof Error ? error.message : "unknown error";
				log("whoyou_node_shutdown_error", { error: message });
			} finally {
				config.db.close();
				process.exit(0);
			}
		})();
	};

	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "unknown error";
	log("whoyou_node_fatal", { error: message });
	process.exitCode = 1;
});
