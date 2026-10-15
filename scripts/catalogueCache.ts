#!/usr/bin/env node
/**
 * Protected operator checks for the process-local catalogue cache.
 * Run from the host or CI, never expose as an HTTP route.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVICE = "kbs-web";
const forbiddenHeaders = ["Cache-Control: public", "s-maxage", "stale-while-revalidate"];

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function replicaCount(): number | null {
  try {
    const output = run("docker", [
      "ps",
      "--filter",
      "label=com.docker.compose.service=kbs-web",
      "--format",
      "{{.ID}}",
    ]);
    if (!output) return 0;
    return output.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return null;
  }
}

function preflight(): never {
  const count = replicaCount();
  const enabled = count === 1;
  if (count === 1) {
    const preflightFile = "/run/kbs/replica-preflight.json";
    try {
      mkdirSync("/run/kbs", { recursive: true });
      writeFileSync(preflightFile, JSON.stringify({ count, source: "dokploy", verified: true }));
    } catch {
      process.stderr.write("catalogue cache preflight evidence unavailable\n");
      return process.exit(1);
    }
  }
  const reason = count === null ? "unknown" : enabled ? "exactly_one" : "not_exactly_one";
  const evidence = {
    event: "catalogue_cache_replica_preflight",
    count,
    enabled,
    reason,
    cacheAction: enabled ? "enabled" : "disabled",
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!enabled) {
    process.stderr.write("catalogue cache disabled: replica count unknown or not exactly one\n");
    return process.exit(1);
  }
  return process.exit(0);
}

function inspect(container = SERVICE): never {
  const count = replicaCount();
  if (count !== 1) {
    process.stderr.write("refusing inspect: replica count is not exactly one\n");
    return process.exit(1);
  }
  try {
    run("docker", ["kill", "--signal=SIGUSR2", container]);
    process.stdout.write(
      `${JSON.stringify({ event: "catalogue_cache_inspect_requested", container, signal: "SIGUSR2", count: 1 })}\n`,
    );
    return process.exit(0);
  } catch {
    process.stderr.write("catalogue cache inspect failed\n");
    return process.exit(1);
  }
}

function clear(container = SERVICE): never {
  const count = replicaCount();
  if (count !== 1) {
    process.stderr.write("refusing clear: replica count is not exactly one\n");
    return process.exit(1);
  }
  try {
    run("docker", ["compose", "restart", SERVICE]);
    const health = run("docker", ["inspect", "--format", "{{.State.Health.Status}}", container]);
    const healthy = health === "healthy";
    process.stdout.write(
      `${JSON.stringify({ event: "catalogue_cache_restart_clear", container, count: 1, health, healthy })}\n`,
    );
    return process.exit(healthy ? 0 : 1);
  } catch {
    process.stderr.write("catalogue cache protected restart failed\n");
    return process.exit(1);
  }
}

function media(container = SERVICE): never {
  try {
    const files = run("docker", [
      "exec",
      container,
      "find",
      "/data/media/derivatives",
      "-type",
      "f",
    ]);
    process.stdout.write(
      `${JSON.stringify({ event: "media_derivative_manifest", count: files ? files.split(/\r?\n/).length : 0 })}\n`,
    );
    const result = spawnSync("pnpm", ["images:verify"], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    return process.exit(result.status ?? 1);
  } catch {
    process.stderr.write("media persistence check failed\n");
    return process.exit(1);
  }
}

function headers(): never {
  const base = process.env.GITHUB_BASE_REF
    ? "origin/" + process.env.GITHUB_BASE_REF
    : "origin/main";
  let changedOutput = "";
  try {
    changedOutput = run("git", ["diff", "--name-only", base + "...HEAD"]);
  } catch {
    changedOutput = run("git", ["diff", "--name-only", "HEAD~1...HEAD"]);
  }
  const changed = changedOutput
    .split(/\r?\n/)
    .filter(
      (file) =>
        file.startsWith("app/") &&
        !file.startsWith("app/media/[...path]/") &&
        /catalogue|gowns/i.test(file),
    );
  const violations: string[] = [];
  for (const file of changed) {
    const source = readFileSync(file, "utf8");
    for (const header of forbiddenHeaders) {
      if (source.includes(header)) {
        violations.push(file + ": " + header);
      }
    }
  }
  if (violations.length) {
    process.stderr.write(violations.join("\n") + "\n");
    return process.exit(1);
  }
  process.stdout.write("catalogue public header check passed (" + changed.length + " files)\n");
  return process.exit(0);
}

const [command, target] = process.argv.slice(2);
switch (command) {
  case "preflight":
    preflight();
    break;
  case "inspect":
    inspect(target);
    break;
  case "clear":
    clear(target);
    break;
  case "media":
    media(target);
    break;
  case "headers":
    headers();
    break;
  default:
    process.stderr.write(
      "usage: catalogueCache.ts <preflight|inspect|clear|media|headers> [container]\n",
    );
    process.exit(2);
}
